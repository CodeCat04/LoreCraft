import { familyNotices, type FamilyChange } from './syncNotice';

function change(partial: Partial<FamilyChange>): FamilyChange {
  return { type: 'added', pageId: 'p', title: 'Bran', field: 'Spouse', other: 'Aria', alongside: [], ...partial };
}

describe('familyNotices', () => {
  it('says nothing when nothing changed', () => {
    expect(familyNotices([])).toEqual([]);
  });

  it('names a single change', () => {
    expect(familyNotices([change({})])[0].text).toBe("Aria was added to Bran's Spouse field.");
    expect(familyNotices([change({ type: 'removed' })])[0].text).toBe("Aria was removed from Bran's Spouse field.");
  });

  it('sums up several ordinary changes in one line', () => {
    const notices = familyNotices([
      change({}),
      change({ title: 'Aria', other: 'Bran' }),
      change({ title: 'Cara', other: 'Bran', type: 'removed' }),
    ]);
    expect(notices).toEqual([{ text: 'Family details updated on Bran, Aria and Cara.', kind: 'info' }]);
  });

  it('always spells out an addition next to another value', () => {
    const notices = familyNotices([change({}), change({ title: 'Cara', alongside: ['Dov', 'Esk'] })]);
    expect(notices.map((n) => n.text)).toEqual([
      "Aria was added to Bran's Spouse field.",
      "Cara's Spouse field already lists Dov and Esk, so Aria was added next to it.",
    ]);
  });

  it('sums up a long run of additions rather than burying the screen', () => {
    const many = ['Cara', 'Dov', 'Esk', 'Fen'].map((title) => change({ title, alongside: ['Gale'] }));
    expect(familyNotices(many)).toEqual([{ text: 'Family details updated on Cara, Dov, Esk and Fen.', kind: 'info' }]);
  });

  it('explains a relationship kept for its note', () => {
    const [notice] = familyNotices([change({ type: 'kept' })]);
    expect(notice.text).toContain('has a note, so it was kept');
  });

  it('reports a title that would not fit as an error, which stays until dismissed', () => {
    const [notice] = familyNotices([change({ type: 'noRoom', other: 'Tomas, Lord of Reeds' })]);
    expect(notice.kind).toBe('error');
    expect(notice.text).toContain("Tomas, Lord of Reeds could not be added to Bran's Spouse field");
  });
});
