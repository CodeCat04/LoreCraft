import type { FieldChange } from '../../lib/facts';
import type { Era } from '../../lib/storyDate';
import type { InfoboxField, InfoboxFieldKind, PageStatus, PmNode } from '../../lib/types';
import type { FindingDraft } from '../types';
import { certainlyBefore } from './dates';
import { sentenceAround, textBlocks } from './docText';
import { runRuleChecks, buildWorld, type WorldInput, type WorldNode, type WorldPage } from './index';
import { editDistance, namesLookAlike } from './names';

// ---- A small world to test with ---------------------------------------------------------

function text(value: string): PmNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }] };
}

function linked(before: string, label: string, target: string, after: string): PmNode {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: before },
          { type: 'text', text: label, marks: [{ type: 'wikiLink', attrs: { target } }] },
          { type: 'text', text: after },
        ],
      },
    ],
  };
}

const KINDS: Record<string, InfoboxFieldKind> = { species: 'page', parents: 'pages', spouse: 'pages', location: 'page' };

function f(key: string, value: string, changes?: FieldChange[]): InfoboxField {
  return { key, label: key[0].toUpperCase() + key.slice(1), kind: KINDS[key] ?? 'text', value, ...(changes ? { changes } : {}) };
}

function page(id: string, title: string, options: { status?: PageStatus; aliases?: string[]; fields?: InfoboxField[]; content?: PmNode; summary?: string; isHome?: boolean } = {}): WorldPage {
  return {
    id,
    title,
    pageType: 'character',
    status: options.status ?? 'canon',
    summary: options.summary ?? '',
    aliases: options.aliases ?? [],
    isHome: options.isHome,
    content: options.content ?? text(''),
    infobox: { fields: options.fields ?? [] },
  };
}

let position = 0;

function scene(id: string, options: { title?: string; date?: string; pov?: string | null; cast?: string[]; location?: string | null; content?: PmNode; parentId?: string | null } = {}): WorldNode {
  position += 1;
  return {
    id,
    bookId: 'book',
    parentId: options.parentId ?? null,
    kind: 'scene',
    title: options.title ?? id,
    position,
    status: 'draft',
    povPageId: options.pov ?? null,
    synopsis: '',
    wordCount: 0,
    targetWords: 0,
    storyDate: options.date ?? '',
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
    content: options.content ?? text(''),
    castPageIds: options.cast,
    locationPageId: options.location,
  };
}

function check(pages: WorldPage[], nodes: WorldNode[] = [], eras: Era[] = []): FindingDraft[] {
  const input: WorldInput = { pages, nodes, books: [{ id: 'book', title: 'Book', position: 0 }] };
  return runRuleChecks(buildWorld(input, eras));
}

function rules(findings: FindingDraft[]): string[] {
  return findings.map((finding) => finding.rule);
}

// ---- Dates ------------------------------------------------------------------------------

describe('certainlyBefore', () => {
  it('compares different years', () => {
    expect(certainlyBefore(300, 301)).toBe(true);
    expect(certainlyBefore(301, 300)).toBe(false);
  });

  it('does not place a bare year against a date in that year', () => {
    expect(certainlyBefore(312, 312.0415)).toBe(false);
    expect(certainlyBefore(312.0415, 312)).toBe(false);
  });

  it('compares months and days when both have them', () => {
    expect(certainlyBefore(312.0415, 312.0515)).toBe(true);
    expect(certainlyBefore(312.0415, 312.0416)).toBe(true);
    expect(certainlyBefore(312.04, 312.0416)).toBe(false);
    expect(certainlyBefore(312.0416, 312.0415)).toBe(false);
  });

  it('works for years before zero', () => {
    expect(certainlyBefore(-40, -39)).toBe(true);
    // Parts of a year always sort above the year itself, as in `parseStoryDate`.
    expect(certainlyBefore(-40 + 0.0102, -40 + 0.0103)).toBe(true);
    expect(certainlyBefore(-40 + 0.0103, -40 + 0.0102)).toBe(false);
  });
});

// ---- Names ------------------------------------------------------------------------------

describe('namesLookAlike', () => {
  it.each([
    ['Aria', 'Arya'],
    ['Karsten', 'Karstem'],
    ['Eowyn', 'Éowyn'],
    ['The Archive', 'Archive'],
    ['Marienne', 'Marianne'],
    ['Silverwood', 'Silverwold'],
  ])('%s and %s look alike', (a, b) => {
    expect(namesLookAlike(a, b)).toBe(true);
  });

  it.each([
    ['Tom', 'Tim'],
    ['Book 1', 'Book 2'],
    ['Year 312', 'Year 313'],
    ['Northland', 'Southland'],
    ['East Wing', 'West Wing'],
    ['North Gate', 'South Gate'],
    ['Dragon', 'Dragons'],
    ['Aria', 'Bram'],
    ['Aria Vale', 'Aria'],
    ['Lord Kane', 'Lady Kane'],
  ])('%s and %s do not', (a, b) => {
    expect(namesLookAlike(a, b)).toBe(false);
  });

  it('counts a swap of two letters as one edit', () => {
    expect(editDistance('aria', 'aira', 2)).toBe(1);
    expect(editDistance('aria', 'bram', 2)).toBe(3);
  });
});

describe('near-duplicate names', () => {
  it('finds them across titles and aliases, once per pair of pages', () => {
    const found = check([
      page('a', 'Aria', { aliases: ['Lady Aria'] }),
      page('b', 'Arya', { aliases: ['Lady Arya'] }),
      page('c', 'Bram', { aliases: ['Brann the Tall'] }),
      page('d', 'Tall Keep', { aliases: ['Brann the Tell'] }),
    ]);
    expect(rules(found)).toEqual(['similar-names', 'similar-names']);
    const aria = found.find((finding) => finding.fingerprint === 'similar-names:a:b');
    expect(aria?.evidence.map((e) => e.quote)).toEqual(['Aria', 'Arya']);
  });

  it('does not compare a page with its own aliases, retconned pages or the main page', () => {
    expect(check([page('a', 'Aria', { aliases: ['Arya'] })])).toEqual([]);
    expect(check([page('a', 'Aria'), page('b', 'Arya', { status: 'retconned' })])).toEqual([]);
    expect(check([page('a', 'Main Page'), page('b', 'Main Pages', { isHome: true })])).toEqual([]);
  });
});

describe('shared aliases', () => {
  it('finds an alias on two pages', () => {
    const found = check([page('a', 'Aria', { aliases: ['The Swift'] }), page('b', 'Bram', { aliases: ['the swift'] })]);
    expect(rules(found)).toEqual(['shared-alias']);
    expect(found[0].evidence.map((e) => e.sourceId)).toEqual(['a', 'b']);
  });

  it("finds an alias that is another page's title", () => {
    const found = check([page('a', 'Aria', { aliases: ['Bram'] }), page('b', 'Bram')]);
    expect(rules(found)).toEqual(['shared-alias']);
    expect(found[0].detail).toContain('always goes to the page with that title, Bram');
  });

  it('accepts an alias the same as the page title', () => {
    expect(check([page('a', 'Aria', { aliases: ['aria'] })])).toEqual([]);
  });
});

// ---- Dates on a page --------------------------------------------------------------------

describe('dates in the wrong order', () => {
  it.each([
    ['born', 'died', '320', '300'],
    ['founded', 'dissolved', '500', '450'],
    ['start', 'end', '12', '4'],
  ])('finds %s after %s', (first, second, a, b) => {
    const found = check([page('a', 'Aria', { fields: [f(first, a), f(second, b)] })]);
    expect(rules(found)).toEqual(['date-order']);
    expect(found[0].severity).toBe('error');
  });

  it('accepts dates in order or on the same day', () => {
    expect(check([page('a', 'Aria', { fields: [f('born', '300'), f('died', '340')] })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', '300'), f('died', '300')] })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', '300-04-15'), f('died', '300')] })])).toEqual([]);
  });

  it('says nothing about dates it cannot order', () => {
    expect(check([page('a', 'Aria', { fields: [f('born', 'the spring of the comet'), f('died', '300')] })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', '40 Third Age'), f('died', '12 Dark Age')] })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', ''), f('died', '300')] })])).toEqual([]);
  });

  it('uses the eras of the project', () => {
    const eras: Era[] = [{ name: 'BE', offset: 0, negative: true }, { name: 'AE', offset: 0 }];
    expect(rules(check([page('a', 'Aria', { fields: [f('born', '10 AE'), f('died', '40 BE')] })], [], eras))).toEqual(['date-order']);
    expect(check([page('a', 'Aria', { fields: [f('born', '40 BE'), f('died', '10 AE')] })], [], eras)).toEqual([]);
    // Without the eras these cannot be ordered, so nothing is guessed.
    expect(check([page('a', 'Aria', { fields: [f('born', '10 AE'), f('died', '40 BE')] })])).toEqual([]);
  });

  it('accepts a date that changes if any pair of values fits', () => {
    const died = f('died', '300', [{ value: '340', nodeId: 'later' }]);
    expect(check([page('a', 'Aria', { fields: [f('born', '320'), died] })])).toEqual([]);
  });

  it('ignores ideas and retconned pages, which do not state facts', () => {
    const fields = [f('born', '320'), f('died', '300')];
    expect(check([page('a', 'Aria', { status: 'idea', fields })])).toEqual([]);
    expect(check([page('a', 'Aria', { status: 'retconned', fields })])).toEqual([]);
    expect(rules(check([page('a', 'Aria', { status: 'draft', fields })]))).toEqual(['date-order']);
  });
});

describe('children and parents', () => {
  it('finds a child born before a parent', () => {
    const found = check([
      page('c', 'Colm', { fields: [f('born', '300'), f('parents', 'Maera, Tobin')] }),
      page('m', 'Maera', { fields: [f('born', '320')] }),
      page('t', 'Tobin', { fields: [f('born', '280')] }),
    ]);
    expect(rules(found)).toEqual(['parent-order']);
    expect(found[0].fingerprint).toBe('parent-order:c:m');
  });

  it('finds a child born more than a year after a parent died, comparing two pages', () => {
    const found = check([
      page('c', 'Colm', { fields: [f('born', '330'), f('parents', 'Maera, Tobin')] }),
      page('m', 'Maera', { fields: [f('born', '280'), f('died', '320')] }),
      page('t', 'Tobin', { fields: [f('born', '280'), f('died', '329')] }),
    ]);
    expect(rules(found)).toEqual(['born-after-parent-died']);
    expect(found[0].fingerprint).toBe('born-after-parent-died:c:m');
  });
});

// ---- Characters in scenes ---------------------------------------------------------------

describe('after death', () => {
  const dead = () => page('a', 'Aria', { aliases: ['the Swift'], fields: [f('died', '300')] });

  it('finds the dead in a point of view or cast', () => {
    const pov = check([dead()], [scene('s', { date: '310', pov: 'a' })]);
    expect(rules(pov)).toEqual(['after-death']);
    expect(pov[0].severity).toBe('error');
    const cast = check([dead()], [scene('s', { date: '310', cast: ['a'] })]);
    expect(rules(cast)).toEqual(['after-death']);
    expect(cast[0].severity).toBe('error');
  });

  it('finds them named in the text, as a lesser warning that quotes the sentence', () => {
    const found = check([dead()], [scene('s', { date: '310', content: text('It rained. Aria drew her sword and ran.') })]);
    expect(rules(found)).toEqual(['after-death']);
    expect(found[0].severity).toBe('warning');
    expect(found[0].evidence[1].quote).toBe('Aria drew her sword and ran.');
  });

  it('finds them by alias', () => {
    const found = check([dead()], [scene('s', { date: '310', content: text('The Swift drew her sword.') })]);
    expect(rules(found)).toEqual(['after-death']);
  });

  it('accepts being remembered', () => {
    const memories = [
      "They stood at Aria's grave.",
      'He remembered how Aria used to laugh.',
      "Aria's ghost walked the hall.",
    ];
    for (const memory of memories) {
      expect(check([dead()], [scene('s', { date: '310', content: text(memory) })])).toEqual([]);
    }
  });

  it('accepts scenes before or at the death, undated or with dates it cannot order', () => {
    const nodes = [
      scene('before', { date: '290', pov: 'a' }),
      scene('same', { date: '300', pov: 'a' }),
      scene('undated', { pov: 'a' }),
      scene('vague', { date: 'the year of the flood', pov: 'a' }),
    ];
    expect(check([dead()], nodes)).toEqual([]);
  });

  it('does not match part of a word', () => {
    expect(check([dead()], [scene('s', { date: '310', content: text('Variation and Ariadne came by.') })])).toEqual([]);
  });

  it('does not take a common word for a name', () => {
    const hope = page('h', 'Hope', { fields: [f('died', '300')] });
    expect(check([hope], [scene('s', { date: '310', content: text('She had hope in her heart.') })])).toEqual([]);
    expect(rules(check([hope], [scene('s', { date: '310', content: text('She saw Hope in the hall.') })]))).toEqual(['after-death']);
  });

  it('reads the date of death as of the scene, so a return from the dead counts', () => {
    const risen = page('a', 'Aria', { fields: [f('died', '300', [{ date: '305', value: '' }])] });
    expect(check([risen], [scene('s', { date: '310', pov: 'a' })])).toEqual([]);
    expect(rules(check([risen], [scene('s', { date: '302', pov: 'a' })]))).toEqual(['after-death']);
  });

  it('counts a death that is added later in the story only from then on', () => {
    const later = page('a', 'Aria', { fields: [f('died', '', [{ date: '320', value: '320' }])] });
    expect(check([later], [scene('s', { date: '310', pov: 'a' })])).toEqual([]);
    expect(rules(check([later], [scene('s', { date: '330', pov: 'a' })]))).toEqual(['after-death']);
  });

  it('takes the date from the chapter if the scene has none', () => {
    const chapter: WorldNode = { ...scene('chapter', { date: '310' }), kind: 'chapter' };
    expect(rules(check([dead()], [chapter, scene('s', { pov: 'a', parentId: 'chapter' })]))).toEqual(['after-death']);
  });

  it('does not treat a retconned death as fact', () => {
    const old = page('a', 'Aria', { status: 'retconned', fields: [f('died', '300')] });
    expect(check([old], [scene('s', { date: '310', pov: 'a' })])).toEqual([]);
  });
});

describe('before birth', () => {
  const young = () => page('a', 'Aria', { fields: [f('born', '300')] });

  it('finds someone present before being born', () => {
    expect(rules(check([young()], [scene('s', { date: '290', pov: 'a' })]))).toEqual(['before-birth']);
    expect(rules(check([young()], [scene('s', { date: '290', cast: ['a'] })]))).toEqual(['before-birth']);
  });

  it('accepts their being named, which may be a prophecy', () => {
    expect(check([young()], [scene('s', { date: '290', content: text('Aria will come.') })])).toEqual([]);
  });
});

describe('age and birth date', () => {
  it('finds an age that contradicts the date of a scene they are in', () => {
    const found = check(
      [page('a', 'Aria', { fields: [f('born', '300'), f('age', '40')] })],
      [scene('s', { date: '320', pov: 'a' })],
    );
    expect(rules(found)).toEqual(['age-vs-born']);
    expect(found[0].detail).toContain('about 20');
  });

  it('allows a year either way for a birthday', () => {
    const aria = () => page('a', 'Aria', { fields: [f('born', '300'), f('age', '20')] });
    expect(check([aria()], [scene('s', { date: '319', pov: 'a' })])).toEqual([]);
    expect(check([aria()], [scene('s', { date: '321', pov: 'a' })])).toEqual([]);
  });

  it('accepts a single age that fits any scene, since it describes one moment', () => {
    const aria = page('a', 'Aria', { fields: [f('born', '300'), f('age', '20')] });
    expect(check([aria], [scene('one', { date: '320', pov: 'a' }), scene('two', { date: '340', pov: 'a' })])).toEqual([]);
  });

  it('reads an age that changes as of each scene', () => {
    const age = f('age', '20', [{ date: '330', value: '30' }]);
    const aria = page('a', 'Aria', { fields: [f('born', '300'), age] });
    expect(check([aria], [scene('one', { date: '320', pov: 'a' }), scene('two', { date: '335', pov: 'a' })])).toEqual([]);
    const wrong = page('b', 'Bram', { fields: [f('born', '300'), f('age', '20', [{ date: '330', value: '50' }])] });
    const found = check([wrong], [scene('one', { date: '320', pov: 'b' }), scene('two', { date: '335', pov: 'b' })]);
    expect(rules(found)).toEqual(['age-vs-born']);
    expect(found[0].fingerprint).toBe('age-vs-born:b:50');
  });

  it('says nothing without an order or a number', () => {
    expect(check([page('a', 'Aria', { fields: [f('born', 'long ago'), f('age', '40')] })], [scene('s', { date: '320', pov: 'a' })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', '300'), f('age', 'ageless')] })], [scene('s', { date: '320', pov: 'a' })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', '300'), f('age', '40')] })], [scene('s', { date: 'someday', pov: 'a' })])).toEqual([]);
    expect(check([page('a', 'Aria', { fields: [f('born', '300'), f('age', '40')] })], [scene('s', { date: '320' })])).toEqual([]);
  });
});

// ---- References -------------------------------------------------------------------------

describe('scene details pointing at missing pages', () => {
  it('finds a deleted point of view, location or cast member', () => {
    const found = check([page('a', 'Aria')], [scene('s', { pov: 'gone', location: 'gone2', cast: ['a', 'gone3'] })]);
    expect(rules(found)).toEqual(['missing-reference', 'missing-reference', 'missing-reference']);
    expect(found.map((finding) => finding.title).join()).toContain('point of view');
    expect(found.map((finding) => finding.title).join()).toContain('location');
    expect(found.map((finding) => finding.title).join()).toContain('cast member');
  });

  it('copes with those fields being absent', () => {
    const node = scene('s');
    delete node.castPageIds;
    delete node.locationPageId;
    expect(check([page('a', 'Aria')], [node])).toEqual([]);
  });
});

describe('broken links', () => {
  it('finds a link with no page, in pages and scenes, quoting the sentence', () => {
    const found = check(
      [page('a', 'Aria', { content: linked('She came first. She went to ', 'the fort', 'Fort Doom', '. Then home.') })],
      [scene('s', { content: linked('', 'Doom', 'Fort Doom', ' fell.') })],
    );
    expect(rules(found)).toEqual(['broken-link', 'broken-link']);
    expect(found[0].severity).toBe('info');
    expect(found[0].evidence[0].quote).toBe('She went to the fort.');
    expect(found[1].evidence[0].quote).toBe('Doom fell.');
  });

  it('accepts a link to a title or an alias, in any case', () => {
    const pages = [
      page('f', 'Fort Doom', { aliases: ['The Fort'] }),
      page('a', 'Aria', { content: linked('She went to ', 'it', 'fort_doom', '.') }),
      page('b', 'Bram', { content: linked('He went to ', 'it', 'the  fort', '.') }),
    ];
    expect(check(pages)).toEqual([]);
  });

  it('reports each missing target once per document', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One', marks: [{ type: 'wikiLink', attrs: { target: 'Nowhere' } }] }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two', marks: [{ type: 'wikiLink', attrs: { target: 'nowhere' } }] }] },
      ],
    };
    expect(rules(check([page('a', 'Aria', { content: doc })]))).toEqual(['broken-link']);
  });
});

describe('infobox fields that point nowhere', () => {
  it('finds page and pages fields with no page', () => {
    const found = check([
      page('a', 'Aria', { fields: [f('species', 'Selkie'), f('parents', 'Bram, Nobody')] }),
      page('b', 'Bram'),
    ]);
    expect(rules(found).sort()).toEqual(['broken-field-link', 'broken-field-link']);
    expect(found.map((finding) => finding.evidence[0].quote).sort()).toEqual(['Parents: Nobody', 'Species: Selkie']);
  });

  it('checks a value the field held earlier as well', () => {
    const found = check([page('a', 'Aria', { fields: [f('location', '', [{ nodeId: 'n', value: 'Nowhere' }])] })]);
    expect(rules(found)).toEqual(['broken-field-link']);
  });

  it('ignores empty fields and text fields', () => {
    expect(check([page('a', 'Aria', { fields: [f('species', ''), f('eyes', 'Selkie')] })])).toEqual([]);
  });
});

describe('canon pages relying on retconned ones', () => {
  const old = () => page('o', 'Old Tower', { status: 'retconned', summary: 'A tower of glass.' });

  it('finds a link stated as fact', () => {
    const found = check([old(), page('a', 'Aria', { content: linked('She lives in ', 'the tower', 'Old Tower', '.') })]);
    expect(rules(found)).toEqual(['retconned-link']);
    expect(found[0].evidence[0].quote).toBe('She lives in the tower.');
    expect(found[0].evidence[1].quote).toBe('A tower of glass.');
  });

  it('finds an infobox field pointing at it', () => {
    expect(rules(check([old(), page('a', 'Aria', { fields: [f('location', 'Old Tower')] })]))).toEqual(['retconned-link']);
  });

  it('accepts a page that says so', () => {
    expect(check([old(), page('a', 'Aria', { content: linked('She once was said to live in ', 'the tower', 'Old Tower', ', a myth.') })])).toEqual([]);
    expect(check([old(), page('a', 'Aria', { content: linked('Earlier drafts had ', 'the tower', 'Old Tower', ' here.') })])).toEqual([]);
  });

  it('only looks at canon pages', () => {
    expect(check([old(), page('a', 'Aria', { status: 'draft', content: linked('She lives in ', 'the tower', 'Old Tower', '.') })])).toEqual([]);
  });
});

// ---- Text ------------------------------------------------------------------------------

describe('document text', () => {
  it('joins a link split over several runs', () => {
    const doc: PmNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'To ' },
            { type: 'text', text: 'the ', marks: [{ type: 'wikiLink', attrs: { target: 'Fort' } }] },
            { type: 'text', text: 'fort', marks: [{ type: 'wikiLink', attrs: { target: 'Fort' } }, { type: 'bold' }] },
          ],
        },
      ],
    };
    expect(textBlocks(doc)).toEqual([{ text: 'To the fort', links: [{ target: 'Fort', from: 3, to: 11 }] }]);
  });

  it('finds the sentence around a spot', () => {
    const value = 'One. "Two is here," she said. Three!';
    expect(sentenceAround(value, 6)).toBe('"Two is here," she said.');
    expect(sentenceAround(value, 31)).toBe('Three!');
  });
});

describe('a large project', () => {
  it('stays fast enough to run each time the screen opens', () => {
    const pages: WorldPage[] = [];
    for (let i = 0; i < 2000; i += 1) {
      pages.push(page(`p${i}`, `Person Number ${i.toString(36)}x${(i * 7919).toString(36)}`, { fields: [f('born', '300'), f('died', '400'), f('age', '30')] }));
    }
    const prose = 'The rain fell on the long road, and nobody said anything for a while. '.repeat(100);
    const nodes: WorldNode[] = [];
    for (let i = 0; i < 1000; i += 1) nodes.push(scene(`s${i}`, { date: '330', content: text(prose) }));
    const started = performance.now();
    const found = check(pages, nodes);
    const took = performance.now() - started;
    expect(found.filter((finding) => finding.rule !== 'similar-names')).toEqual([]);
    // Generous, since this runs on machines doing other work.
    expect(took).toBeLessThan(10_000);
  }, 30_000);
});

describe('a quiet project', () => {
  it('has nothing to report', () => {
    const pages = [
      page('h', 'Main Page', { isHome: true }),
      page('a', 'Aria', { fields: [f('born', '300'), f('age', '20'), f('died', '360'), f('eyes', 'green')] }),
      page('v', 'Vale', { fields: [f('founded', '100'), f('location', '')] }),
    ];
    const nodes = [scene('s', { date: '320', pov: 'a', location: 'v', cast: ['a'], content: text('Aria walked the Vale.') })];
    expect(check(pages, nodes)).toEqual([]);
  });
});
