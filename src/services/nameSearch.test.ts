import { describe, it, expect } from 'vitest';
import { scoreMatch, sortByRelevance, foldForSearch, matchesSearch } from './nameSearch';

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

  it('ignores accents on both sides', () => {
    expect(scoreMatch('Sliabh Bána', 'sliabh bana')).toBe(0);
    expect(scoreMatch('Sliabh Bana', 'sliabh bána')).toBe(0);
  });

  it('sees an accented letter as part of its word', () => {
    // Unfolded, \b does not count "í" as a letter: "tula" read as a whole word
    // inside "Tulaí", outranking a name where it really is one.
    expect(scoreMatch('Ríl na Tulaí', 'tula')).toBe(4);
    expect(scoreMatch('Ríl na Tulaí', 'tulai')).toBe(3);
  });
});

describe('foldForSearch', () => {
  it('drops accents and case', () => {
    expect(foldForSearch('Ríl Na Tulaí')).toBe('ril na tulai');
    expect(foldForSearch('Éire')).toBe('eire');
  });

  it('drops the dot of old Irish script letters', () => {
    expect(foldForSearch('Amaċ San Ḟarraige')).toBe('amac san farraige');
  });

  it('maps the letters NFD cannot split, in either case', () => {
    expect(foldForSearch('Cœur Ærø Łódź Ǥ ı Straße')).toBe('coeur aero lodz g i strasse');
  });
});

describe('matchesSearch', () => {
  it('finds an accented name from an unaccented query, and the reverse', () => {
    expect(matchesSearch('Ríl na Tulaí', 'tulai')).toBe(true);
    expect(matchesSearch('Ril na Tulai', 'TULAÍ')).toBe(true);
  });

  it('matches everything on an empty query, like includes', () => {
    expect(matchesSearch('Cooley\'s', '')).toBe(true);
  });

  it('still rejects a real mismatch', () => {
    expect(matchesSearch('Drowsy Maggie', 'molly')).toBe(false);
  });
});
