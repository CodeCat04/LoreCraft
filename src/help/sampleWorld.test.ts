import { describe, expect, it } from 'vitest';

import { normalizeLorebookFile } from '../exporters/import/lorebookFile';
import { parseEras, parseStoryDate } from '../lib/storyDate';
import { titleKey } from '../lib/text';
import { templateFor, TEMPLATES } from '../wiki/templates';
import { PLANTED, SAMPLE_BOOK, SAMPLE_PAGES, SAMPLE_RELATIONSHIPS, SAMPLE_WORLD } from './sampleWorld';

const titles = new Set(SAMPLE_PAGES.flatMap((p) => [p.title, ...(p.aliases ?? [])].map(titleKey)));

/** Red links left on purpose, as things for the reader to try. */
const UNWRITTEN = new Set(['The Tithe Barges', 'Hob Corrow'].map(titleKey));

function fieldsOf(page: (typeof SAMPLE_PAGES)[number]) {
  return page.infobox?.fields ?? [];
}

function pageNamed(title: string) {
  const page = SAMPLE_PAGES.find((p) => p.title === title);
  if (!page) throw new Error(`No page called ${title}`);
  return page;
}

const scenes = SAMPLE_BOOK.children.flatMap((chapter) => chapter.children);

function sceneNamed(title: string) {
  const scene = scenes.find((s) => s.title === title);
  if (!scene) throw new Error(`No scene called ${title}`);
  return scene;
}

describe('sample world', () => {
  it('is a valid file, read with no errors or warnings', () => {
    const { payload, problems } = normalizeLorebookFile(SAMPLE_WORLD);
    expect(problems).toEqual([]);
    expect(payload.pages).toHaveLength(SAMPLE_PAGES.length);
    expect(payload.books).toHaveLength(1);
    expect(payload.meta).toHaveProperty('eras');
  });

  it('has about fifteen pages, in a mix of types and statuses', () => {
    expect(SAMPLE_PAGES.length).toBeGreaterThanOrEqual(14);
    expect(SAMPLE_PAGES.length).toBeLessThanOrEqual(18);
    expect(new Set(SAMPLE_PAGES.map((p) => p.status))).toEqual(new Set(['canon', 'draft', 'idea', 'retconned']));
    const types = new Set(SAMPLE_PAGES.map((p) => p.pageType));
    for (const type of ['character', 'place', 'faction', 'item', 'event', 'concept', 'species', 'organization']) {
      expect(types).toContain(type);
    }
    expect(SAMPLE_PAGES.filter((p) => p.isHome)).toHaveLength(1);
  });

  it('builds its infoboxes from the wiki templates', () => {
    for (const page of SAMPLE_PAGES) {
      if (!page.infobox) continue;
      const known = TEMPLATES.some((t) => t.type === page.pageType);
      expect(known, `${page.title} has a template`).toBe(true);
      const template = templateFor(page.pageType);
      expect(fieldsOf(page).map((f) => f.key)).toEqual(template.fields.map((f) => f.key));
      expect(fieldsOf(page).some((f) => f.value !== ''), `${page.title} has some facts`).toBe(true);
    }
  });

  it('uses aliases, categories and summaries', () => {
    for (const page of SAMPLE_PAGES) {
      expect(page.summary, page.title).toBeTruthy();
      expect(page.categories?.length, page.title).toBeGreaterThan(0);
    }
    expect(SAMPLE_PAGES.filter((p) => p.aliases?.length).length).toBeGreaterThanOrEqual(8);
  });

  it('links only to pages that exist, apart from the red links left on purpose', () => {
    const missing = new Set<string>();
    for (const page of SAMPLE_PAGES) {
      for (const [, target] of page.content.matchAll(/\[\[([^\]|]+)/g)) {
        if (!titles.has(titleKey(target)) && !UNWRITTEN.has(titleKey(target))) missing.add(`${page.title}: ${target}`);
      }
      for (const field of fieldsOf(page)) {
        if (field.kind !== 'page' && field.kind !== 'pages') continue;
        for (const target of [field.value].flat()) {
          if (target && !titles.has(titleKey(target)) && !UNWRITTEN.has(titleKey(target))) {
            missing.add(`${page.title}, ${field.key}: ${target}`);
          }
        }
      }
    }
    expect([...missing]).toEqual([]);
    for (const relation of SAMPLE_RELATIONSHIPS) {
      expect(titles).toContain(titleKey(relation.from));
      expect(titles).toContain(titleKey(relation.to));
    }
  });

  it('writes every in-world date in a form that can be put in order', () => {
    const eras = parseEras(SAMPLE_WORLD.project.meta.eras);
    const dates = [
      ...SAMPLE_PAGES.flatMap((page) => fieldsOf(page).filter((f) => f.kind === 'date' && f.value !== '').map((f) => String(f.value))),
      ...scenes.map((scene) => scene.storyDate),
    ];
    expect(dates.length).toBeGreaterThan(10);
    for (const date of dates) {
      expect(parseStoryDate(date), date).not.toBeNull();
      expect(parseStoryDate(date, eras), date).not.toBeNull();
    }
  });

  it('has a short book of two chapters, whose scenes name the characters', () => {
    expect(SAMPLE_BOOK.children).toHaveLength(2);
    for (const chapter of SAMPLE_BOOK.children) expect(chapter.children.length).toBeGreaterThanOrEqual(2);
    const prose = scenes.map((scene) => scene.content ?? '').join('\n');
    for (const name of ['Wren Halloway', 'Tam Corrow', 'Isolde Marrable', 'Bram Ketteridge', 'Oswin Halloway']) {
      expect(prose).toContain(name);
    }
    for (const scene of scenes) expect(titles).toContain(titleKey(scene.pov));
    expect(new Set(scenes.map((scene) => scene.status)).size).toBeGreaterThan(2);
  });

  it('records where each scene happens, who is in it, and its plot threads', () => {
    const threads = new Set(SAMPLE_WORLD.threads.map((t) => t.name));
    for (const scene of scenes) {
      expect(titles).toContain(titleKey(scene.location));
      expect(scene.cast.length).toBeGreaterThan(0);
      for (const name of scene.cast) expect(titles).toContain(titleKey(name));
      expect(scene.cast).toContain(scene.pov);
      for (const thread of scene.threads) expect(threads).toContain(thread);
    }
  });

  it('shows a fact that changes during the story', () => {
    const owner = fieldsOf(pageNamed('The Tallow Key')).find((f) => f.key === 'owner') as { value: string; changes?: { value: string }[] };
    expect(owner.value).toBe('Oswin Halloway');
    expect(owner.changes?.[0].value).toBe('Wren Halloway');
  });

  it('really contains the mistakes it says it has', () => {
    // A character appears after their death, by name and in the cast.
    const dead = PLANTED.appearsAfterDeath;
    const died = fieldsOf(pageNamed(dead.character)).find((f) => f.key === 'died')!.value as string;
    const scene = sceneNamed(dead.scene);
    expect(parseStoryDate(scene.storyDate)!).toBeGreaterThan(parseStoryDate(died)!);
    expect(scene.content).toContain(dead.character);
    expect(scene.cast).toContain(dead.character);

    // Two pages whose titles differ by one letter.
    const [one, other] = PLANTED.nearDuplicateNames;
    expect(pageNamed(one).title.length - pageNamed(other).title.length).toBe(1);

    // The manuscript contradicts an infobox and the article.
    const eyes = PLANTED.contradictsInfobox;
    const character = pageNamed(eyes.character);
    expect(fieldsOf(character).find((f) => f.key === eyes.field)!.value).toBe('Grey');
    expect(character.content).toContain('grey eyes');
    expect(sceneNamed(eyes.scene).content).toContain(eyes.said);
  });

  it('notes each planted mistake on a page', () => {
    const notes = pageNamed('About this sample').content;
    expect(notes).toContain(PLANTED.appearsAfterDeath.character);
    expect(notes).toContain(PLANTED.appearsAfterDeath.scene);
    for (const name of PLANTED.nearDuplicateNames) expect(notes).toContain(name);
    expect(notes).toContain(PLANTED.contradictsInfobox.character);
    expect(notes).toContain(PLANTED.contradictsInfobox.scene);
    expect(SAMPLE_PAGES[0].content).toContain('[[About this sample]]');
  });

  it('otherwise agrees with itself about who died when', () => {
    // Only the one planted scene may place a character after their death.
    const deaths = SAMPLE_PAGES.flatMap((page) => {
      const died = fieldsOf(page).find((f) => f.key === 'died')?.value;
      return died ? [{ title: page.title, died: parseStoryDate(died as string)! }] : [];
    });
    for (const scene of scenes) {
      for (const { title, died } of deaths) {
        if ((scene.content ?? '').includes(title) && parseStoryDate(scene.storyDate)! > died) {
          expect(scene.title).toBe(PLANTED.appearsAfterDeath.scene);
        }
      }
    }
  });
});
