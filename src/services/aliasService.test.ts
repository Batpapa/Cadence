import { describe, it, expect } from 'vitest';
import {
  cardAliases, setCardAliases, sourceAliases, aliasProblem, addAlias, renameAlias, removeAlias,
  promoteAliasToName, refreshedAliases,
} from './aliasService';
import { applyTheSessionAliases, applyTheSessionName, tuneResultToCard, type TuneResult } from './theSessionService';
import { parseCardPackageFromText, cardsTextReport } from './importExport';
import { rankByRelevance, scoreWithAliases, NO_SCORE_MATCH } from '../utils';
import type { AppState, Card } from '../types';

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'c1', guid: 'g1', name: "Cooley's", defaultImportance: 1, tags: [],
    content: { notes: '', attachments: [] },
    ...over,
  };
}

const tune: TuneResult = {
  id: 1, name: "Cooley's", type: 'reel', url: 'https://thesession.org/tunes/1', tunebooks: 10, topKey: null,
  settings: [],
  aliases: ['Reaping The Rye', 'The Tulla', 'Cooleys'],
};

describe('the stored shape', () => {
  it('reads an absent list as empty', () => {
    expect(cardAliases(card())).toEqual([]);
  });

  it('writes an empty list as no field at all, so an emptied card equals an untouched one', () => {
    const c = card({ aliases: ['x'] });
    setCardAliases(c, []);
    expect('aliases' in c).toBe(false);
  });

  it("normalises a source's catalogue order and keeps its duplicates", () => {
    expect(sourceAliases(['Tulla, The', ' Drowsey Maggie ', 'Drowsey Maggie', ''])).toEqual(['The Tulla', 'Drowsey Maggie', 'Drowsey Maggie']);
  });
});

describe('editing by hand', () => {
  it('refuses the name and an alias already there, nothing else', () => {
    const c = card({ aliases: ['The Tulla'] });
    expect(aliasProblem(c, "  Cooley's ")).toBe('isName');
    expect(aliasProblem(c, 'The Tulla')).toBe('alreadyAlias');
    expect(aliasProblem(c, '   ')).toBe('empty');
    expect(aliasProblem(c, 'the tulla')).toBeNull();
  });

  it('adds at the end, trimmed', () => {
    const c = card({ aliases: ['The Tulla'] });
    expect(addAlias(c, ' Reaping the Rye ')).toBe(true);
    expect(c.aliases).toEqual(['The Tulla', 'Reaping the Rye']);
    expect(addAlias(c, 'The Tulla')).toBe(false);
  });

  it('renames in place, and renaming to itself is not a collision', () => {
    const c = card({ aliases: ['A', 'B', 'C'] });
    expect(renameAlias(c, 1, 'B')).toBe(true);
    expect(renameAlias(c, 1, 'Bee')).toBe(true);
    expect(c.aliases).toEqual(['A', 'Bee', 'C']);
    expect(renameAlias(c, 1, 'C')).toBe(false);
  });

  it('removes by position, so one of two identical aliases goes and not both', () => {
    const c = card({ aliases: ['Cooleys', 'X', 'Cooleys'] });
    removeAlias(c, 2);
    expect(c.aliases).toEqual(['Cooleys', 'X']);
    removeAlias(c, 0); removeAlias(c, 0);
    expect(c.aliases).toBeUndefined();
  });
});

describe('use as name', () => {
  it('swaps the alias and the name, the old name taking its place in the list', () => {
    const c = card({ aliases: ['The Tulla', 'Reaping the Rye', 'Luttrell\'s Pass'] });
    promoteAliasToName(c, 1);
    expect(c.name).toBe('Reaping the Rye');
    expect(c.aliases).toEqual(['The Tulla', "Cooley's", "Luttrell's Pass"]);
  });

  it('stops a set from naming itself, as typing a name does', () => {
    const c = card({ type: 'tuneset', computedName: true, aliases: ['The Kesh set'] });
    promoteAliasToName(c, 0);
    expect(c.computedName).toBeUndefined();
    expect(c.name).toBe('The Kesh set');
  });
});

describe('refreshing from TheSession', () => {
  it("overwrites the list with TheSession's", () => {
    const c = card({ aliases: ['my own'] });
    applyTheSessionAliases(c, tune);
    expect(c.aliases).toEqual(['Reaping The Rye', 'The Tulla', 'Cooleys']);
  });

  it("keeps TheSession's name among the aliases when the card goes by another", () => {
    // Renamed to an alias, then refreshed: without this "Cooley's" would be
    // neither the name nor an alias, and no search for it would find the card.
    const c = card({ name: 'Reaping the Rye' });
    applyTheSessionAliases(c, tune);
    expect(c.aliases).toEqual(["Cooley's", 'Reaping The Rye', 'The Tulla', 'Cooleys']);
  });

  it('does not add the name when the card already carries it, accents and case aside', () => {
    expect(refreshedAliases(card({ name: "cooley's" }), "Cooley's", ['A'])).toEqual(['A']);
  });

  it('reads the name the refresh just wrote, when both are ticked in that order', () => {
    const c = card({ name: 'Reaping the Rye' });
    applyTheSessionName(c, tune);
    applyTheSessionAliases(c, tune);
    expect(c.aliases).toEqual(['Reaping The Rye', 'The Tulla', 'Cooleys']);
  });

  it('removes the field when TheSession has no aliases', () => {
    const c = card({ aliases: ['x'] });
    applyTheSessionAliases(c, { ...tune, aliases: [] });
    expect('aliases' in c).toBe(false);
  });

  it('prefills a new card, and leaves the field out when there is nothing', () => {
    expect(tuneResultToCard(tune).aliases).toEqual(tune.aliases);
    expect('aliases' in tuneResultToCard({ ...tune, aliases: [] })).toBe(false);
  });
});

describe('searching names and aliases', () => {
  const cards = [
    { name: 'The Kesh', aliases: ['Castle', 'The Kincora'] },
    { name: 'The Castle', aliases: [] },
    { name: "Cooley's", aliases: ['Put The Cake In The Dresser'] },
  ];

  it('finds a card through an alias its name does not contain, and says which', () => {
    const hits = rankByRelevance(cards, 'cake in the dresser');
    expect(hits).toEqual([{ item: cards[2], via: 'Put The Cake In The Dresser' }]);
  });

  it('ranks a name match before an alias match of the same tier', () => {
    // "castle" ends both strings as a whole word (same tier). Alphabetically
    // "The Kesh" would lead; the card NAMED so comes first instead.
    const tied = [
      { name: 'The Kesh', aliases: ['Old Castle'] },
      { name: 'Zulu Castle', aliases: [] },
    ];
    const hits = rankByRelevance(tied, 'castle');
    expect(hits.map(h => h.item.name)).toEqual(['Zulu Castle', 'The Kesh']);
    expect(hits[1]!.via).toBe('Old Castle');
  });

  it('lets a better alias outrank a weaker name match', () => {
    // Exact alias (tier 0) beats "castle" as a word inside "The Castle" (tier 3).
    expect(rankByRelevance(cards, 'Castle').map(h => h.item.name)).toEqual(['The Kesh', 'The Castle']);
  });

  it('does not name an alias when the name matched as well', () => {
    expect(scoreWithAliases('The Kesh', ['The Kesh Jig'], 'kesh').via).toBeUndefined();
    expect(scoreWithAliases('The Kesh', ['Castle'], 'nope').score).toBe(NO_SCORE_MATCH);
  });
});

describe('packages and exports', () => {
  it('keeps aliases through a package, cleaned, and drops a malformed list', () => {
    const text = JSON.stringify({ schemaVersion: 8, cards: [
      { name: 'A', aliases: ['One', 42, '  ', ' Two '] },
      { name: 'B', aliases: 'not a list' },
      { name: 'C', aliases: [] },
    ] });
    const [a, b, c] = parseCardPackageFromText(text);
    expect(a!.aliases).toEqual(['One', 'Two']);
    expect('aliases' in b!).toBe(false);
    expect('aliases' in c!).toBe(false);
  });

  it('lists them in the text export', () => {
    const user = { decks: {}, cardWorks: {}, currentProfileId: 'p' } as unknown as AppState;
    const report = cardsTextReport([card({ aliases: ['The Tulla', 'Reaping the Rye'] })], user);
    expect(report).toContain('Aliases:  The Tulla; Reaping the Rye');
  });
});
