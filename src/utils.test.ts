import { describe, it, expect } from 'vitest';
import { normalizeDisplayName, scoreMatch, sortByRelevance } from './utils';

describe('normalizeDisplayName', () => {
  it('moves a trailing ", The" to the front', () => {
    expect(normalizeDisplayName('Kesh, The')).toBe('The Kesh');
  });

  it('moves a trailing ", A" to the front', () => {
    expect(normalizeDisplayName('Silver Spear, A')).toBe('A Silver Spear');
  });

  it('moves a trailing ", An" to the front', () => {
    expect(normalizeDisplayName('Old Bush, An')).toBe('An Old Bush');
  });

  it('leaves a name with no trailing article unchanged', () => {
    expect(normalizeDisplayName('Drowsy Maggie')).toBe('Drowsy Maggie');
  });

  it('leaves a name ending in something that only looks like an article unchanged (no comma)', () => {
    expect(normalizeDisplayName('Behind The Haystack')).toBe('Behind The Haystack');
  });

  it('does not touch a comma NOT immediately followed by a bare article (nothing else may trail)', () => {
    expect(normalizeDisplayName('Kesh, The (reel)')).toBe('Kesh, The (reel)');
  });

  it('preserves the source casing of the moved article', () => {
    expect(normalizeDisplayName('kesh, the')).toBe('the kesh');
  });

  it('only strips the LAST trailing article, keeping an earlier comma-joined part intact', () => {
    expect(normalizeDisplayName('Rakes of Kildare, The')).toBe('The Rakes of Kildare');
  });
});

describe('scoreMatch', () => {
  it('ranks an exact match above everything else', () => {
    expect(scoreMatch('Inch', 'inch')).toBe(0);
  });

  it('ranks starting with the query as its own whole word above starting with it mid-word', () => {
    expect(scoreMatch('Inch Reel', 'inch')).toBeLessThan(scoreMatch('Inchindown', 'inch'));
  });

  it('ranks a whole-word match elsewhere in the name above a same-name mid-word match', () => {
    // "inch" is a whole word (trailing) in "The Mystery Inch", but only a
    // buried fragment ("f-inch") in "The Goldfinch" — regression case from
    // 2026-08-24, the whole reason this 3-way split exists.
    expect(scoreMatch('The Mystery Inch', 'inch')).toBeLessThan(scoreMatch('The Goldfinch', 'inch'));
  });

  it('ranks a word-prefix match (starts a word, does not complete it) above a pure mid-word fragment', () => {
    // "inch" starts the word "Inchindown" (word-boundary on the left) but
    // doesn't complete it — better than "Goldfinch", where "inch" has no
    // boundary alignment on either side.
    expect(scoreMatch('The Inchindown', 'inch')).toBeLessThan(scoreMatch('The Goldfinch', 'inch'));
  });

  it('still ranks a whole-word match above a word-prefix match', () => {
    expect(scoreMatch('The Mystery Inch', 'inch')).toBeLessThan(scoreMatch('The Inchindown', 'inch'));
  });

  it('still matches (worst tier) a query buried with no boundary alignment at all', () => {
    expect(scoreMatch('The Goldfinch', 'inch')).toBeLessThan(6);
  });

  it('reproduces the exact reported ordering for query "inch"', () => {
    const names = ['The Girls Of Ballinahinch', 'The Goldfinch', 'The Inchindown', 'The Mystery Inch'];
    const sorted = sortByRelevance(names.map(name => ({ name })), 'inch').map(t => t.name);
    expect(sorted).toEqual(['The Mystery Inch', 'The Inchindown', 'The Girls Of Ballinahinch', 'The Goldfinch']);
  });

  it('a whole-word match elsewhere ranks above a word-prefix match elsewhere, for a real-world name pair', () => {
    // "kesh" is a whole word (trailing) in "Sean Coughlan's Kesh", but only
    // starts a word ("Keshan", not completing it) in "The Keshan Reel".
    expect(scoreMatch("Sean Coughlan's Kesh", 'kesh')).toBeLessThan(scoreMatch('The Keshan Reel', 'kesh'));
  });

  it('does not crash on regex-special characters in the query', () => {
    expect(() => scoreMatch("O'Carolan's Draught", "o'carolan's")).not.toThrow();
    expect(scoreMatch("O'Carolan's Draught", "o'carolan's")).toBe(1);
  });
});
