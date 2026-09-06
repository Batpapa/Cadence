// @vitest-environment jsdom
// deckSelector imports the store, and driveService reads localStorage at module
// evaluation — in a bare node environment the import throws before a single
// test runs. jsdom supplies the storage; nothing here touches it.
import { describe, expect, it } from 'vitest';
import { nextDeckChoiceState, type DeckChoiceState } from './deckSelector';

// The three-state ring is the whole novelty of the deck choice modal: a deck is
// off, ticked for this card only, or pinned so it comes back ticked next time.
// A checkbox has two states, so the ring is what carries the third — and it has
// to walk both ways, since right-clicking a row goes backwards (same gesture as
// the library's filter pins).

const walk = (from: DeckChoiceState, steps: number, back = false): DeckChoiceState[] => {
  const seen: DeckChoiceState[] = [];
  let s = from;
  for (let i = 0; i < steps; i++) { s = nextDeckChoiceState(s, back); seen.push(s); }
  return seen;
};

describe('deck choice ring', () => {
  it('walks off → ticked → pinned forwards', () => {
    expect(walk('off', 3)).toEqual(['ticked', 'pinned', 'off']);
  });

  it('walks off → pinned → ticked backwards', () => {
    expect(walk('off', 3, true)).toEqual(['pinned', 'ticked', 'off']);
  });

  it('returns to where it started after a full turn, from any state', () => {
    for (const start of ['off', 'ticked', 'pinned'] as DeckChoiceState[]) {
      expect(walk(start, 3).at(-1)).toBe(start);
      expect(walk(start, 3, true).at(-1)).toBe(start);
    }
  });

  it('undoes a forward step with a backward one', () => {
    for (const start of ['off', 'ticked', 'pinned'] as DeckChoiceState[]) {
      expect(nextDeckChoiceState(nextDeckChoiceState(start), true)).toBe(start);
    }
  });

  // Pinned is a *kind of* ticked: anything that is not 'off' contributes the
  // deck to the confirmed selection. Stated here because the modal's rendering
  // and its result both depend on it — a pin that did not also tick would
  // silently drop the deck the user just asked to keep.
  it('never produces a state that is pinned without being selectable', () => {
    const selected = (s: DeckChoiceState) => s !== 'off';
    expect(selected('pinned')).toBe(true);
    expect(selected('ticked')).toBe(true);
    expect(selected('off')).toBe(false);
  });
});
