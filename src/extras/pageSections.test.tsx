import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

import type { TitleEntry } from '../lib/types';
import type { Relationship } from './api';
import { matchTitles } from './common/PageAutocomplete';
import { PageRelationships } from './graph/relationships';
import { AppearsOnMaps } from './maps/MapsView';

const rpcMock = vi.hoisted(() => vi.fn());

vi.mock('../lib/rpc', async (original) => ({
  ...(await original<typeof import('../lib/rpc')>()),
  rpc: rpcMock,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function relationship(partial: Partial<Relationship>): Relationship {
  return {
    id: 'r1',
    fromPageId: 'aria',
    fromTitle: 'Aria',
    toPageId: 'bran',
    toTitle: 'Bran',
    kind: 'parent of',
    inverse: 'child of',
    note: '',
    createdAt: '',
    ...partial,
  };
}

describe('matchTitles', () => {
  const entry = (title: string, aliases: string[] = []): TitleEntry => ({
    id: title,
    title,
    pageType: 'article',
    status: 'draft',
    summary: '',
    aliases,
  });
  const entries = [entry('Aria'), entry('Maria'), entry('Silver Vale', ['The Vale']), entry('Valerian')];
  const titles = (text: string, excludeId?: string) => matchTitles(entries, text, excludeId).map((e) => e.title);

  it('puts titles that start with the text first', () => {
    expect(titles('ari')).toEqual(['Aria', 'Maria']);
    expect(titles('val')).toEqual(['Valerian', 'Silver Vale']);
  });

  it('finds aliases, ignoring case and extra spaces', () => {
    expect(titles('THE   vale')).toEqual(['Silver Vale']);
  });

  it('can leave one page out', () => {
    expect(titles('ari', 'Aria')).toEqual(['Maria']);
  });

  it('offers nothing for nothing', () => {
    expect(titles('   ')).toEqual([]);
  });

  it('keeps the list short', () => {
    const many = Array.from({ length: 50 }, (_, i) => entry(`Page ${i}`));
    expect(matchTitles(many, 'page')).toHaveLength(8);
  });
});

describe('sections a page can show', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    rpcMock.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function show(element: React.ReactNode) {
    await act(async () => {
      root.render(element);
    });
  }

  describe('PageRelationships', () => {
    it('reads each relationship from this page, and links to the other page', async () => {
      rpcMock.mockResolvedValue([
        relationship({ id: 'r1' }),
        relationship({ id: 'r2', fromPageId: 'cara', fromTitle: 'Cara', toPageId: 'aria', toTitle: 'Aria', kind: 'parent of' }),
        relationship({ id: 'r3', toPageId: 'dov', toTitle: 'Dov', kind: 'ally', inverse: 'ally', note: 'Uneasy' }),
        relationship({ id: 'r4', fromPageId: 'esk', fromTitle: 'Esk', toPageId: 'aria', toTitle: 'Aria', kind: 'mentor of', inverse: 'student of' }),
        relationship({ id: 'r5', fromPageId: 'fen', fromTitle: 'Fen', toPageId: 'aria', toTitle: 'Aria', kind: 'liege of', inverse: null }),
      ]);
      await show(<PageRelationships pageId="aria" title="Aria" />);

      expect(rpcMock).toHaveBeenCalledWith('extras.relationshipList', { pageId: 'aria' });
      const lines = [...host.querySelectorAll('.page-relationship-text')].map((el) => el.textContent);
      expect(lines).toEqual([
        'Parent of Bran',
        'Child of Cara',
        'Ally: Dov (Uneasy)',
        'Student of Esk',
        'Fen (liege of this page)',
      ]);
      const links = [...host.querySelectorAll('[data-wiki-target]')].map((el) => el.getAttribute('data-wiki-target'));
      expect(links).toEqual(['Bran', 'Cara', 'Dov', 'Esk', 'Fen']);
    });

    it('links to the family tree from a character page, or a page with family fields', async () => {
      rpcMock.mockResolvedValue([]);
      const buttons = () => [...host.querySelectorAll('button')].map((b) => b.textContent);
      await show(<PageRelationships pageId="aria" pageType="character" />);
      expect(buttons()).toEqual(['Family tree', 'Add']);
      await show(<PageRelationships pageId="aria" pageType="place" />);
      expect(buttons()).toEqual(['Add']);
      const infobox = { fields: [{ key: 'spouse', label: 'Consort', kind: 'pages' as const, value: '' }] };
      await show(<PageRelationships pageId="aria" pageType="noble" infobox={infobox} />);
      expect(buttons()).toEqual(['Family tree', 'Add']);
    });

    it('says what to do when there are none', async () => {
      rpcMock.mockResolvedValue([]);
      await show(<PageRelationships pageId="aria" />);
      expect(host.textContent).toContain('None yet.');
      expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Add']);
    });

    it('reports a failed load rather than looking empty', async () => {
      rpcMock.mockRejectedValue(new Error('The disk is full'));
      await show(<PageRelationships pageId="aria" />);
      expect(host.textContent).toContain('The disk is full');
      expect(host.textContent).not.toContain('None yet.');
    });
  });

  describe('AppearsOnMaps', () => {
    it('lists the maps a page is on', async () => {
      rpcMock.mockResolvedValue([
        { mapId: 'm1', mapTitle: 'The North', pinId: 'p1', x: 0.1, y: 0.2 },
        { mapId: 'm2', mapTitle: 'The South', pinId: 'p2', x: 0.3, y: 0.4 },
      ]);
      await show(<AppearsOnMaps pageId="aria" />);
      expect(rpcMock).toHaveBeenCalledWith('extras.pageMaps', { pageId: 'aria' });
      expect(host.querySelector('h2')?.textContent).toBe('Appears on maps');
      expect([...host.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['The North', 'The South']);
    });

    it('takes up no room when the page is on no map', async () => {
      rpcMock.mockResolvedValue([]);
      await show(<AppearsOnMaps pageId="aria" />);
      expect(host.textContent).toBe('');
    });
  });
});
