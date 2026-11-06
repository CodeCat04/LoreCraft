import { describe, expect, it } from 'vitest';

import { parseCustomTypes } from './pageTypes';
import { TEMPLATES, allTemplates, pluralOf, setCustomTemplates, templateFor, typeLabel, typePlural } from './templates';

describe('custom page types', () => {
  it('survives anything stored', () => {
    expect(parseCustomTypes(null)).toEqual([]);
    expect(parseCustomTypes('not json')).toEqual([]);
    expect(parseCustomTypes('{"a":1}')).toEqual([]);
    expect(parseCustomTypes('[null, 3, {"type":"x"}, {"label":"y"}]')).toEqual([]);
  });

  it('keeps fields without values, and fills in a plural', () => {
    const [deity] = parseCustomTypes(
      JSON.stringify([
        {
          type: 'deity',
          label: 'Deity',
          fields: [{ key: 'domain', label: 'Domain', kind: 'text', value: 'left over' }],
          sections: ['Worship', ' ', 'Myths'],
        },
      ]),
    );
    expect(deity.plural).toBe('Deities');
    expect(deity.fields).toEqual([{ key: 'domain', label: 'Domain', kind: 'text', value: '' }]);
    expect(deity.sections).toEqual(['Worship', 'Myths']);
  });

  it('never lets a stored type replace a built-in one, or repeat', () => {
    const types = parseCustomTypes(
      JSON.stringify([
        { type: 'character', label: 'Fake', fields: [], sections: [] },
        { type: 'deity', label: 'Deity', fields: [], sections: [] },
        { type: 'deity', label: 'Again', fields: [], sections: [] },
      ]),
    );
    expect(types.map((t) => t.label)).toEqual(['Deity']);
  });

  it('are used alongside the built-in types', () => {
    setCustomTemplates(parseCustomTypes(JSON.stringify([{ type: 'war_machine', label: 'War machine', fields: [], sections: ['Crew'] }])));
    try {
      expect(allTemplates()).toHaveLength(TEMPLATES.length + 1);
      expect(templateFor('war_machine').sections).toEqual(['Crew']);
      expect(typeLabel('war_machine')).toBe('War machine');
      expect(typePlural('war_machine')).toBe('War machines');
    } finally {
      setCustomTemplates([]);
    }
  });

  it('still names a type after it is deleted, since pages keep it', () => {
    expect(typeLabel('war_machine')).toBe('War machine');
    expect(templateFor('war_machine').type).toBe('article');
  });
});

describe('pluralOf', () => {
  it('handles the common endings', () => {
    expect(pluralOf('Ship')).toBe('Ships');
    expect(pluralOf('Deity')).toBe('Deities');
    expect(pluralOf('Day')).toBe('Days');
    expect(pluralOf('Witch')).toBe('Witches');
    expect(pluralOf('  ')).toBe('');
  });
});
