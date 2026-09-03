import { describe, it, expect } from 'vitest';
import { resolveCardRef, findBacklinks, findSetsContaining } from './cardRefService';
import type { Card, CardReferenceAttachment } from '../types';

function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id, guid: `guid-${id}`, name: id, defaultImportance: 1, tags: [],
    content: { notes: '', attachments: [] },
    ...over,
  };
}
function ref(over: Partial<CardReferenceAttachment> = {}): CardReferenceAttachment {
  return { type: 'card', id: 'x', guid: 'guid-x', title: 'x', ...over };
}
const lib = (...cs: Card[]): Record<string, Card> => Object.fromEntries(cs.map(c => [c.id, c]));
const withRefs = (id: string, refs: CardReferenceAttachment[], over: Partial<Card> = {}) =>
  card(id, { ...over, content: { notes: '', attachments: refs } });

describe('resolveCardRef', () => {
  it('prefers the local id', () => {
    const cards = lib(card('a'), card('b'));
    expect(resolveCardRef(ref({ id: 'a', guid: 'guid-b' }), cards)?.id).toBe('a');
  });

  it('falls back to the guid when the id is gone', () => {
    const cards = lib(card('b'));
    expect(resolveCardRef(ref({ id: 'vanished', guid: 'guid-b' }), cards)?.id).toBe('b');
  });

  it('falls back to the external id last', () => {
    const cards = lib(card('b', { externalId: 'thesession:42' }));
    expect(resolveCardRef(ref({ id: 'vanished', guid: 'also-gone', externalId: 'thesession:42' }), cards)?.id).toBe('b');
  });

  it('returns null when nothing matches', () => {
    expect(resolveCardRef(ref({ id: 'nope', guid: 'nope' }), lib(card('a')))).toBeNull();
  });
});

describe('findBacklinks', () => {
  it('finds the cards whose reference resolves here', () => {
    const target = card('t');
    const cards = lib(target, withRefs('a', [ref({ id: 't', guid: 'guid-t' })]), card('b'));
    expect(findBacklinks('t', cards).map(c => c.id)).toEqual(['a']);
  });

  it('FOLLOWS RESOLUTION ORDER: a reference whose id wins is not a backlink of the card its guid happens to match', () => {
    // The reference sits on 'src', its id points at 'a', its guid at 'b'.
    // Clicking it opens 'a' — so only 'a' may list it, never 'b'.
    const cards = lib(
      card('a'), card('b'),
      withRefs('src', [ref({ id: 'a', guid: 'guid-b' })]),
    );
    expect(findBacklinks('a', cards).map(c => c.id)).toEqual(['src']);
    expect(findBacklinks('b', cards)).toEqual([]);
  });

  it('lists a card once even when it references the target several times', () => {
    const cards = lib(
      card('t'),
      withRefs('a', [ref({ id: 't', guid: 'guid-t' }), ref({ id: 't', guid: 'guid-t', title: 'again' })]),
    );
    expect(findBacklinks('t', cards).map(c => c.id)).toEqual(['a']);
  });

  it('excludes a card that references itself', () => {
    const cards = lib(withRefs('t', [ref({ id: 't', guid: 'guid-t' })]));
    expect(findBacklinks('t', cards)).toEqual([]);
  });

  it('ignores references that resolve to nothing', () => {
    const cards = lib(card('t'), withRefs('a', [ref({ id: 'gone', guid: 'gone-too' })]));
    expect(findBacklinks('t', cards)).toEqual([]);
  });

  it('ignores attachments that are not card references', () => {
    const cards = lib(
      card('t'),
      withRefs('a', [{ type: 'file', id: 'f1', name: 'tune.abc' } as never]),
    );
    expect(findBacklinks('t', cards)).toEqual([]);
  });

  it('counts a reference resolved through the guid fallback', () => {
    const cards = lib(card('t'), withRefs('a', [ref({ id: 'stale-id', guid: 'guid-t' })]));
    expect(findBacklinks('t', cards).map(c => c.id)).toEqual(['a']);
  });

  it('sorts by name so the list is stable', () => {
    const r = [ref({ id: 't', guid: 'guid-t' })];
    const cards = lib(
      card('t'),
      withRefs('c1', r, { name: 'Zulu' }),
      withRefs('c2', r, { name: 'Alpha' }),
      withRefs('c3', r, { name: 'Mike' }),
    );
    expect(findBacklinks('t', cards).map(c => c.name)).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('returns nothing for a card nobody references', () => {
    expect(findBacklinks('t', lib(card('t'), card('a')))).toEqual([]);
  });
});

describe('findSetsContaining', () => {
  const tuneset = (id: string, refs: CardReferenceAttachment[], over: Partial<Card> = {}) =>
    card(id, { ...over, type: 'tuneset', tunes: refs });

  it('finds the sets whose tune list resolves here', () => {
    const cards = lib(card('t'), tuneset('s', [ref({ id: 't', guid: 'guid-t' })]), card('b'));
    expect(findSetsContaining('t', cards).map(c => c.id)).toEqual(['s']);
  });

  it('IGNORES a tunes list on a card that is not typed as a set', () => {
    // `type` decides, not the presence of the list — otherwise a card demoted
    // back to an ordinary one would keep claiming membership.
    const cards = lib(card('t'), card('s', { tunes: [ref({ id: 't', guid: 'guid-t' })] }));
    expect(findSetsContaining('t', cards)).toEqual([]);
  });

  it('is DISJOINT from findBacklinks — the two sections never show the same card', () => {
    const r = ref({ id: 't', guid: 'guid-t' });
    const cards = lib(
      card('t'),
      tuneset('s', [r]),                       // plays it
      withRefs('m', [r]),                      // merely mentions it
    );
    expect(findSetsContaining('t', cards).map(c => c.id)).toEqual(['s']);
    expect(findBacklinks('t', cards).map(c => c.id)).toEqual(['m']);
  });

  it('does not count a set that only MENTIONS the tune in its attachments', () => {
    const cards = lib(
      card('t'),
      card('s', { type: 'tuneset', tunes: [], content: { notes: '', attachments: [ref({ id: 't', guid: 'guid-t' })] } }),
    );
    expect(findSetsContaining('t', cards)).toEqual([]);
    expect(findBacklinks('t', cards).map(c => c.id)).toEqual(['s']);
  });

  it('follows the same resolution order as a reference click', () => {
    const cards = lib(
      card('a'), card('b'),
      tuneset('s', [ref({ id: 'a', guid: 'guid-b' })]),
    );
    expect(findSetsContaining('a', cards).map(c => c.id)).toEqual(['s']);
    expect(findSetsContaining('b', cards)).toEqual([]);
  });

  it('lists a set once even when it plays the tune twice', () => {
    const r = ref({ id: 't', guid: 'guid-t' });
    const cards = lib(card('t'), tuneset('s', [r, r]));
    expect(findSetsContaining('t', cards).map(c => c.id)).toEqual(['s']);
  });

  it('sorts by name, and survives a set with no tunes', () => {
    const r = ref({ id: 't', guid: 'guid-t' });
    const cards = lib(
      card('t'),
      tuneset('s1', [r], { name: 'Zulu' }),
      tuneset('s2', [r], { name: 'Alpha' }),
      card('s3', { type: 'tuneset' }),
    );
    expect(findSetsContaining('t', cards).map(c => c.name)).toEqual(['Alpha', 'Zulu']);
  });
});
