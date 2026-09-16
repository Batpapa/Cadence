import { describe, it, expect } from 'vitest';
import { normalizeDisplayName, scoreMatch, sortByRelevance, foldForSearch, matchesSearch, formatBytes, titleCaseTuneName } from './utils';

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

// formatBytes is what tells someone a recording is about to be re-uploaded on
// every sync, and what stands between them and the embed budget. A figure that
// reads wrong there is a decision made on wrong information.
describe('formatBytes', () => {
  it('keeps plain bytes below a kilobyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
  });

  it('drops the decimal once the number is big enough to carry itself', () => {
    // Below ten units a tenth is information; above it, it is noise.
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
  });

  it('climbs a unit at a time', () => {
    expect(formatBytes(1024)).toBe('1.0 kB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('reports the embed budget as the round number it is', () => {
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });
});

describe('titleCaseTuneName — le repli, en attendant le vrai nom', () => {
  // Only ever shown while TheSession's name index is downloading (see
  // sessionUiShared's tuneName): the card's name and the index both win over
  // it. Rules are acceptable here because nothing is stored from them and the
  // index corrects whatever they get wrong.
  it('capitalise un nom ordinaire', () => {
    expect(titleCaseTuneName('the kesh')).toBe('The Kesh');
    expect(titleCaseTuneName("cooley's")).toBe("Cooley's");
  });

  it('laisse les petits mots en bas de casse A L INTERIEUR du titre', () => {
    // What CSS `capitalize` could not do: it produced "The Bucks Of Oranmore".
    expect(titleCaseTuneName('the bucks of oranmore')).toBe('The Bucks of Oranmore');
    expect(titleCaseTuneName('the boys on the hilltop')).toBe('The Boys on the Hilltop');
  });

  it('reconstruit la majuscule interne des noms en Mc et O', () => {
    // The other thing CSS could not do: it produced "Mcgoldrick's".
    expect(titleCaseTuneName("mcgoldrick's")).toBe("McGoldrick's");
    expect(titleCaseTuneName("o'neill's march")).toBe("O'Neill's March");
    expect(titleCaseTuneName("'ma' mcnulty's favourite")).toBe("'ma' McNulty's Favourite");
  });

  it('ne touche pas a Mac, ou la regle se tromperait', () => {
    expect(titleCaseTuneName('macklin')).toBe('Macklin');
  });

  it('traite chaque morceau d une suite comme un titre a part', () => {
    expect(titleCaseTuneName('the wise maid / the bucks of oranmore'))
      .toBe('The Wise Maid / The Bucks of Oranmore');
  });

  it('capitalise les deux moities d un mot compose', () => {
    expect(titleCaseTuneName('sean-nós')).toBe('Sean-Nós');
  });

  it('ne retouche pas un nom qui a deja des majuscules', () => {
    // It came from a source that kept them — TheSession, or a person typing.
    expect(titleCaseTuneName("McGoldrick's")).toBe("McGoldrick's");
    expect(titleCaseTuneName('The Kesh')).toBe('The Kesh');
  });

  it('survit a un nom vide', () => {
    expect(titleCaseTuneName('')).toBe('');
  });
});
