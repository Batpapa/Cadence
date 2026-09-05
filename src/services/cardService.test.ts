import { describe, it, expect } from 'vitest';
import { removeCards } from './cardService';
import { orphanedCardsAfterDeckRemoval } from './deckService';
import { emptyState } from '../utils';
import type { AppState } from '../types';

// Deleting a card is the one operation here that cannot be undone, and it was
// the only one with no test at all. What it has to leave behind is as much the
// contract as what it removes: the decks survive, other cards' work survives,
// and nothing of the deleted card does — for ANY profile, which is the part
// that was wrong until 2026-09-05 (see removeCards' own doc).

const P1 = 'profile-1';
const P2 = 'profile-2';

function stateWith(...profileIds: string[]): AppState {
  const s = emptyState();
  s.profileIds = [...profileIds];
  s.currentProfileId = profileIds[0] ?? '';
  for (const id of profileIds) s.profiles[id] = { id, name: id };
  return s;
}

function addCard(s: AppState, id: string): void {
  s.cards[id] = { id, guid: `guid-${id}`, name: id, defaultImportance: 1, tags: [], content: { notes: '', attachments: [] } };
}

function addDeck(s: AppState, id: string, cardIds: string[]): void {
  s.decks[id] = { id, name: id, entries: cardIds.map(cardId => ({ cardId })) };
}

function addWork(s: AppState, profileId: string, cardId: string, reviews = 1): void {
  s.cardWorks[`${profileId}:${cardId}`] = {
    profileId,
    cardId,
    history: Array.from({ length: reviews }, (_, i) => ({ ts: 1_000 + i, rating: 'good' as const })),
  };
}

describe('removeCards', () => {
  it('removes the card itself', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addCard(s, 'b');

    removeCards(s, ['a']);

    expect(s.cards['a']).toBeUndefined();
    expect(s.cards['b']).toBeDefined();
  });

  it('takes the card out of every deck without deleting any deck', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addCard(s, 'b');
    addDeck(s, 'd1', ['a', 'b']);
    addDeck(s, 'd2', ['a']);
    addDeck(s, 'd3', ['b']);

    removeCards(s, ['a']);

    expect(Object.keys(s.decks).sort()).toEqual(['d1', 'd2', 'd3']);
    expect(s.decks['d1']!.entries.map(e => e.cardId)).toEqual(['b']);
    expect(s.decks['d2']!.entries).toEqual([]);
    expect(s.decks['d3']!.entries.map(e => e.cardId)).toEqual(['b']);
  });

  // The regression. A card is not per-profile: deleting it deletes it for
  // everyone, so leaving another profile's row behind left work reachable from
  // nowhere — no screen could open it, and the dashboard counted it. One real
  // library carried 52 such rows.
  it('removes the work of EVERY profile, not only the current one', () => {
    const s = stateWith(P1, P2);
    addCard(s, 'a');
    addWork(s, P1, 'a', 3);
    addWork(s, P2, 'a', 2);

    removeCards(s, ['a']);

    expect(s.cardWorks).toEqual({});
  });

  it('leaves every other card the profiles have worked on untouched', () => {
    const s = stateWith(P1, P2);
    addCard(s, 'a');
    addCard(s, 'b');
    addWork(s, P1, 'a');
    addWork(s, P1, 'b', 4);
    addWork(s, P2, 'b', 5);

    removeCards(s, ['a']);

    expect(Object.keys(s.cardWorks).sort()).toEqual([`${P1}:b`, `${P2}:b`]);
    expect(s.cardWorks[`${P1}:b`]!.history).toHaveLength(4);
    expect(s.cardWorks[`${P2}:b`]!.history).toHaveLength(5);
  });

  it('removes several cards in one call', () => {
    const s = stateWith(P1, P2);
    for (const id of ['a', 'b', 'c']) { addCard(s, id); addWork(s, P1, id); addWork(s, P2, id); }
    addDeck(s, 'd1', ['a', 'b', 'c']);

    removeCards(s, ['a', 'c']);

    expect(Object.keys(s.cards)).toEqual(['b']);
    expect(s.decks['d1']!.entries.map(e => e.cardId)).toEqual(['b']);
    expect(Object.keys(s.cardWorks).sort()).toEqual([`${P1}:b`, `${P2}:b`]);
  });

  it('is a no-op on a card that is not there, and on one nobody has reviewed', () => {
    const s = stateWith(P1, P2);
    addCard(s, 'a');
    addDeck(s, 'd1', ['a']);

    expect(() => removeCards(s, ['ghost'])).not.toThrow();
    expect(Object.keys(s.cards)).toEqual(['a']);
    expect(s.decks['d1']!.entries).toHaveLength(1);

    removeCards(s, ['a']);
    expect(s.cards['a']).toBeUndefined();
    expect(s.cardWorks).toEqual({});
  });

  // The two paths that delete a deck or a folder "with its orphaned cards" used
  // to write their own half of this by hand, and each kept the same bug. They
  // now compose these two functions, so this is the shape that actually ships.
  it('clears every profile when composed with orphanedCardsAfterDeckRemoval', () => {
    const s = stateWith(P1, P2);
    addCard(s, 'solo');
    addCard(s, 'shared');
    addDeck(s, 'doomed', ['solo', 'shared']);
    addDeck(s, 'kept', ['shared']);
    for (const id of ['solo', 'shared']) { addWork(s, P1, id); addWork(s, P2, id); }

    removeCards(s, orphanedCardsAfterDeckRemoval(['doomed'], s));

    // `shared` lives on in the surviving deck, with everyone's work on it.
    expect(Object.keys(s.cards)).toEqual(['shared']);
    expect(Object.keys(s.cardWorks).sort()).toEqual([`${P1}:shared`, `${P2}:shared`]);
    expect(s.decks['kept']!.entries.map(e => e.cardId)).toEqual(['shared']);
  });
});

describe('orphanedCardsAfterDeckRemoval', () => {
  it('names a card that the removed deck was the last to hold', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addDeck(s, 'd1', ['a']);

    expect(orphanedCardsAfterDeckRemoval(['d1'], s)).toEqual(['a']);
  });

  it('spares a card another deck still holds', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addDeck(s, 'd1', ['a']);
    addDeck(s, 'd2', ['a']);

    expect(orphanedCardsAfterDeckRemoval(['d1'], s)).toEqual([]);
  });

  it('names a card shared only between decks that are all going', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addCard(s, 'b');
    addDeck(s, 'd1', ['a', 'b']);
    addDeck(s, 'd2', ['a']);
    addDeck(s, 'kept', ['b']);

    // `a` is in d1 and d2, both removed → orphaned. `b` survives in `kept`.
    expect(orphanedCardsAfterDeckRemoval(['d1', 'd2'], s)).toEqual(['a']);
  });

  it('returns nothing for an empty list or a deck that is not there', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addDeck(s, 'd1', ['a']);

    expect(orphanedCardsAfterDeckRemoval([], s)).toEqual([]);
    expect(orphanedCardsAfterDeckRemoval(['ghost'], s)).toEqual([]);
  });

  // A card in no deck at all is not the caller's business here: it was already
  // orphaned before the removal, and this answers "what would this removal
  // strand", not "what is stranded".
  it('ignores cards that belong to no deck to begin with', () => {
    const s = stateWith(P1);
    addCard(s, 'a');
    addCard(s, 'loose');
    addDeck(s, 'd1', ['a']);

    expect(orphanedCardsAfterDeckRemoval(['d1'], s)).toEqual(['a']);
  });
});
