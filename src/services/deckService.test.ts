import { describe, it, expect } from 'vitest';
import { pickSequential } from './deckService';
import { emptyState } from '../utils';
import type { AppState, CardWork, Deck } from '../types';

const PROFILE = 'p1';

function makeUser(masteredCardIds: string[] = []): AppState {
  const user = emptyState();
  user.currentProfileId = PROFILE;
  // A review logged right now sits at R ≈ 1, comfortably above the 0.9
  // threshold — that is what "mastered" means to isAvailable(). Cards with no
  // history at all score 0 and stay eligible.
  for (const cardId of masteredCardIds) {
    const work: CardWork = { profileId: PROFILE, cardId, history: [{ ts: Date.now(), rating: 'easy' }] };
    user.cardWorks[`${PROFILE}:${cardId}`] = work;
  }
  return user;
}

function deckOf(...cardIds: string[]): Deck {
  return { id: 'd1', name: 'Deck', entries: cardIds.map(cardId => ({ cardId })) };
}

const next = (user: AppState, deck: Deck, after: string | null, excludeMastered = true) =>
  pickSequential(user, PROFILE, deck, user.cardWorks, excludeMastered, after)?.cardId ?? null;

describe('pickSequential', () => {
  it('starts at the first entry when no card is current', () => {
    expect(next(makeUser(), deckOf('a', 'b', 'c'), null)).toBe('a');
  });

  it('walks the deck order rather than the alphabet or any score', () => {
    const deck = deckOf('c', 'a', 'b');
    const user = makeUser();
    expect(next(user, deck, 'c')).toBe('a');
    expect(next(user, deck, 'a')).toBe('b');
  });

  it('loops back to the top after the last entry', () => {
    expect(next(makeUser(), deckOf('a', 'b', 'c'), 'c')).toBe('a');
  });

  it('skips mastered cards but keeps the deck order', () => {
    const user = makeUser(['b', 'c']);
    expect(next(user, deckOf('a', 'b', 'c', 'd'), 'a')).toBe('d');
  });

  it('skips mastered cards while looping', () => {
    const user = makeUser(['a', 'b']);
    expect(next(user, deckOf('a', 'b', 'c'), 'c')).toBe('c');
  });

  // The regression this mode was designed around: rating the current card
  // "Easy" masters it, dropping it out of the eligible subset. Position must
  // still be read from the full list, or the walk silently restarts at the top.
  it('resumes after a card that was mastered by the rating that just advanced it', () => {
    const user = makeUser(['c']);
    expect(next(user, deckOf('a', 'b', 'c', 'd', 'e'), 'c')).toBe('d');
  });

  it('ignores mastery entirely when excludeMastered is off', () => {
    const user = makeUser(['b', 'c']);
    expect(next(user, deckOf('a', 'b', 'c'), 'a', false)).toBe('b');
  });

  it('restarts at the top when the current card has left the deck', () => {
    expect(next(makeUser(), deckOf('a', 'b'), 'gone')).toBe('a');
  });

  it('hands back the same card when it is the only eligible one left', () => {
    const user = makeUser(['a', 'c']);
    expect(next(user, deckOf('a', 'b', 'c'), 'b')).toBe('b');
  });

  it('returns null when every card is mastered', () => {
    const user = makeUser(['a', 'b']);
    expect(next(user, deckOf('a', 'b'), 'a')).toBeNull();
  });

  it('returns null on an empty deck', () => {
    expect(next(makeUser(), deckOf(), null)).toBeNull();
  });
});
