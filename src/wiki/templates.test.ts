import { describe, expect, it } from 'vitest';

import {
  SEMANTIC_FIELDS,
  TEMPLATES,
  mergeTemplateFields,
  templateBody,
  templateFor,
  templateInfobox,
  typeLabel,
} from './templates';
import { pmToPlainText } from '../editor/convert';

/** The consistency checker reads these exact keys. */
const REQUIRED_KEYS = [
  'born', 'died', 'age', 'species', 'gender', 'affiliation', 'location', 'founded', 'dissolved',
  'date', 'start', 'end', 'parents', 'spouse', 'children', 'leader', 'members', 'owner', 'creator',
  'height', 'eyes', 'hair',
];

describe('templates', () => {
  it('covers every page type from the plan', () => {
    expect(TEMPLATES.map((t) => t.type).sort()).toEqual(
      ['article', 'character', 'concept', 'culture', 'event', 'faction', 'item', 'organization', 'place', 'species'],
    );
  });

  it('defines all the semantic fields', () => {
    expect(Object.keys(SEMANTIC_FIELDS).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  it('uses only semantic keys, with the kind the key requires', () => {
    for (const template of TEMPLATES) {
      const keys = template.fields.map((f) => f.key);
      expect(new Set(keys).size, template.type).toBe(keys.length);
      for (const field of template.fields) {
        expect(SEMANTIC_FIELDS[field.key], `${template.type}.${field.key}`).toBeDefined();
        expect(field.kind).toBe(SEMANTIC_FIELDS[field.key].kind);
        expect(field.value).toBe('');
      }
    }
  });

  it('makes all date fields the date kind', () => {
    for (const key of ['born', 'died', 'founded', 'dissolved', 'date', 'start', 'end']) {
      expect(SEMANTIC_FIELDS[key].kind, key).toBe('date');
    }
  });

  it('gives every non-blank type fields and sections, and the blank article neither', () => {
    for (const template of TEMPLATES) {
      if (template.type === 'article') {
        expect(template.fields).toEqual([]);
        expect(template.sections).toEqual([]);
      } else {
        expect(template.fields.length, template.type).toBeGreaterThan(0);
        expect(template.sections.length, template.type).toBeGreaterThan(0);
      }
    }
  });

  it('builds a body with a lead paragraph first and each section after it', () => {
    const body = templateBody(templateFor('event'));
    expect(body.content?.[0]).toEqual({ type: 'paragraph' });
    expect(body.content?.filter((n) => n.type === 'heading')).toHaveLength(3);
    expect(pmToPlainText(body)).toBe('Background\n\nCourse of events\n\nAftermath');
    expect(templateBody(templateFor('article'))).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });

  it('gives each page its own fields rather than sharing them', () => {
    const a = templateInfobox(templateFor('character'));
    const b = templateInfobox(templateFor('character'));
    a.fields[0].value = 'changed';
    expect(b.fields[0].value).toBe('');
  });

  it('falls back to the blank article for an unknown type', () => {
    expect(templateFor('no such type').type).toBe('article');
  });

  it('names types for people', () => {
    expect(typeLabel('article')).toBe('Article');
    expect(typeLabel('character')).toBe('Character');
    expect(typeLabel('home')).toBe('Main page');
    expect(typeLabel('vehicle')).toBe('Vehicle');
  });

  it('adds only missing fields when a page changes type', () => {
    const merged = mergeTemplateFields(
      { imageAssetId: 'x', fields: [{ key: 'born', label: 'Hatched', kind: 'date', value: 'Year 1' }] },
      templateFor('character'),
    );
    expect(merged.imageAssetId).toBe('x');
    expect(merged.fields[0]).toEqual({ key: 'born', label: 'Hatched', kind: 'date', value: 'Year 1' });
    expect(merged.fields.filter((f) => f.key === 'born')).toHaveLength(1);
    expect(merged.fields.map((f) => f.key)).toContain('died');

    const unchanged = { fields: [] };
    expect(mergeTemplateFields(unchanged, templateFor('article'))).toBe(unchanged);
  });
});
