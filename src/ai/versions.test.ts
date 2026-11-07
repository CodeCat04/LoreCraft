import { activePath, childrenOf, newestLeaf, stepVersion, versionsOf, type VersionNode } from './versions';

/** A chat built the way the store builds one: each message added after its parent. */
function chat() {
  const all: (VersionNode & { text: string })[] = [];
  const add = (text: string, parentId: string | null) => {
    const message = { id: `m${all.length + 1}`, parentId, text };
    all.push(message);
    return message;
  };
  return { all, add };
}

const texts = (path: { text: string }[]) => path.map((m) => m.text);

describe('versions of a chat', () => {
  it('shows a chat with no versions as one line, and the newest line when no leaf is known', () => {
    const { all, add } = chat();
    const q = add('q', null);
    const a = add('a', q.id);
    add('q2', a.id);
    expect(texts(activePath(all, undefined))).toEqual(['q', 'a', 'q2']);
    expect(texts(activePath(all, 'gone'))).toEqual(['q', 'a', 'q2']);
    expect(texts(activePath(all, a.id))).toEqual(['q', 'a']);
    expect(activePath([], null)).toEqual([]);
  });

  it('treats a message with no parent field as starting the chat, as older rows do', () => {
    const path = activePath([{ id: 'a' }, { id: 'b', parentId: 'a' }], 'b');
    expect(path.map((m) => m.id)).toEqual(['a', 'b']);
    expect(childrenOf([{ id: 'a' }], null).map((m) => m.id)).toEqual(['a']);
  });

  it('keeps the replies after an edited message as an earlier version', () => {
    const { all, add } = chat();
    const q1 = add('q1', null);
    const a1 = add('a1', q1.id);
    const q2 = add('q2', a1.id);
    const a2 = add('a2', q2.id);
    add('q3', a2.id);
    // Editing q2 adds a sibling of it, and the rerun follows that.
    const edited = add('q2 edited', a1.id);
    const reply = add('a2 new', edited.id);

    expect(texts(activePath(all, reply.id))).toEqual(['q1', 'a1', 'q2 edited', 'a2 new']);
    expect(versionsOf(all, edited)).toEqual({ index: 1, count: 2, ids: [q2.id, edited.id] });
    expect(versionsOf(all, q1)).toEqual({ index: 0, count: 1, ids: [q1.id] });

    // Going back shows the old version as it was, all the way to its end.
    const back = stepVersion(all, edited, -1);
    expect(texts(activePath(all, back))).toEqual(['q1', 'a1', 'q2', 'a2', 'q3']);
    expect(stepVersion(all, edited, 1)).toBeNull();
    expect(stepVersion(all, q2, 1)).toBe(reply.id);
  });

  it('adds a new reply to the same question as another version', () => {
    const { all, add } = chat();
    const q = add('q', null);
    const first = add('first', q.id);
    const second = add('second', q.id);
    expect(texts(activePath(all, second.id))).toEqual(['q', 'second']);
    expect(versionsOf(all, second)).toMatchObject({ index: 1, count: 2 });
    expect(texts(activePath(all, stepVersion(all, second, -1)))).toEqual(['q', 'first']);
    expect(versionsOf(all, first).index).toBe(0);
  });

  it('follows the newest version at each fork below the one chosen', () => {
    const { all, add } = chat();
    const q = add('q', null);
    const a = add('a', q.id);
    const b = add('b', q.id);
    const followUp = add('follow-up', a.id);
    const older = add('older reply', followUp.id);
    const newer = add('newer reply', followUp.id);
    expect(newestLeaf(all, q.id)).toBe(b.id);
    expect(newestLeaf(all, a.id)).toBe(newer.id);
    expect(stepVersion(all, b, -1)).toBe(newer.id);
    expect(newestLeaf(all, older.id)).toBe(older.id);
  });
});
