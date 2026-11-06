import { filterLibrary, type LibraryItem } from './libraryData';

const item = (fields: Partial<LibraryItem>): LibraryItem => ({
  id: 'x',
  name: 'x.png',
  mime: 'image/png',
  kind: 'image',
  size: 1,
  sha256: null,
  width: null,
  height: null,
  duration: null,
  linked: false,
  path: null,
  missing: false,
  createdAt: '',
  label: '',
  description: '',
  uses: 1,
  inUse: true,
  ...fields,
});

const items = [
  item({ id: 'a', name: 'gate.png', label: 'The Silver Gate', description: 'At dawn' }),
  item({ id: 'b', name: 'storm.mp4', kind: 'video', label: 'Storm over the vale' }),
  item({ id: 'c', name: 'spare.png', uses: 0, inUse: false }),
];

const ids = (list: LibraryItem[]) => list.map((i) => i.id);

describe('filterLibrary', () => {
  it('filters by kind', () => {
    expect(ids(filterLibrary(items, 'all', ''))).toEqual(['a', 'b', 'c']);
    expect(ids(filterLibrary(items, 'image', ''))).toEqual(['a', 'c']);
    expect(ids(filterLibrary(items, 'video', ''))).toEqual(['b']);
  });

  it('finds what nothing uses', () => {
    expect(ids(filterLibrary(items, 'unused', ''))).toEqual(['c']);
  });

  it('searches the name, label and description, in any case and word order', () => {
    expect(ids(filterLibrary(items, 'all', 'storm'))).toEqual(['b']);
    expect(ids(filterLibrary(items, 'all', 'GATE'))).toEqual(['a']);
    expect(ids(filterLibrary(items, 'all', 'dawn silver'))).toEqual(['a']);
    expect(ids(filterLibrary(items, 'all', 'nothing like this'))).toEqual([]);
  });

  it('combines a search with a filter', () => {
    expect(ids(filterLibrary(items, 'video', 'gate'))).toEqual([]);
    expect(ids(filterLibrary(items, 'image', 'png'))).toEqual(['a', 'c']);
  });
});
