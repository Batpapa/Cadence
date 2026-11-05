import { describe, it, expect } from 'vitest';
import { emptyState } from '../utils';
import type { AppState, FilterState } from '../types';
import { deckChipSection, deckChipKnown, NO_DECK } from './deckChips';
import { folderChipKey } from './filterChips';

// Folk (folder) > Reels (folder) > deck "r", and deck "j" filed nowhere.
function user(): AppState {
  return {
    ...emptyState(),
    decks: {
      r: { id: 'r', name: 'Reels deck', entries: [{ cardId: 'c1' }] },
      j: { id: 'j', name: 'Jigs deck', entries: [{ cardId: 'c2' }] },
      x: { id: 'x', name: 'Other deck', entries: [{ cardId: 'c9' }] },
    },
    folders: {
      folk: { id: 'folk', name: 'Folk', folderIds: ['reels'], deckIds: [] },
      reels: { id: 'reels', name: 'Reels', folderIds: [], deckIds: ['r'] },
    },
  } as unknown as AppState;
}
const none = new Map<string, FilterState>();

describe('deckChipSection', () => {
  it('offers the decks holding a card of the pool, by name, and their folders', () => {
    const s = deckChipSection(user(), none, id => id === 'c1' || id === 'c2', false);
    expect(s.items).toEqual(['j', 'r']);
    expect(s.folderItems).toEqual([folderChipKey('folk'), folderChipKey('reels')]);
    expect(s.hasMix).toBe(true);
  });
  it('puts "no deck" first when something is in none', () => {
    const s = deckChipSection(user(), none, id => id === 'c1', true);
    expect(s.items).toEqual([NO_DECK, 'r']);
  });
  it('a card answers to its decks and every folder above them', () => {
    const s = deckChipSection(user(), none, () => true, false);
    expect(s.valuesOf('c1').sort()).toEqual(['r', folderChipKey('folk'), folderChipKey('reels')].sort());
    expect(s.valuesOf('c2')).toEqual(['j']);
  });
  it('a card in no deck, and no card at all, answer to "no deck" alone', () => {
    const s = deckChipSection(user(), none, () => true, false);
    expect(s.valuesOf('c404')).toEqual([NO_DECK]);
    expect(s.valuesOf(undefined)).toEqual([NO_DECK]);
  });
  it('one bucket cannot split, unless a chip is pinned', () => {
    expect(deckChipSection(user(), none, id => id === 'c1', false).hasMix).toBe(false);
    expect(deckChipSection(user(), new Map([['r', 'include']]), id => id === 'c1', false).hasMix).toBe(true);
  });
  it('ignores a chip naming a deck or a folder deleted since', () => {
    const s = deckChipSection(user(), new Map<string, FilterState>([['gone', 'include'], [folderChipKey('gone'), 'exclude'], ['r', 'include']]), () => true, false);
    expect([...s.live.keys()]).toEqual(['r']);
    expect(deckChipKnown(user(), NO_DECK)).toBe(true);
  });
});
