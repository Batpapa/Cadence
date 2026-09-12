import { describe, it, expect } from 'vitest';
import { deckGain } from './tuneBatch';

describe('deckGain', () => {
  const cardOf = (id: string) => (id === 'known' ? 'card-1' : undefined);

  it('counts a tune with no card, because the action creates it', () => {
    expect(deckGain(['unknown'], cardOf, () => true)).toBe(1);
  });

  it('does not count a card the deck already holds', () => {
    expect(deckGain(['known'], cardOf, cardId => cardId === 'card-1')).toBe(0);
  });

  it('counts a card the deck does not hold', () => {
    expect(deckGain(['known'], cardOf, () => false)).toBe(1);
  });

  it('adds the two kinds up', () => {
    expect(deckGain(['known', 'unknown'], cardOf, cardId => cardId === 'card-1')).toBe(1);
  });
});
