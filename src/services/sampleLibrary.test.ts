import { describe, it, expect } from 'vitest';
import { emptyState } from '../utils';
import { addDefaultSamples, addIrishSamples, irishSampleTuneIds } from './sampleLibrary';
import { normaliseState } from './stateNormalise';
import type { TuneResult } from './theSessionService';
import type { AppState } from '../types';

/** A stand-in for what TheSession returns — invented, never its data. */
function fakeTune(id: number): TuneResult {
  return {
    id, name: `Tune ${id}`, type: 'reel', url: '', tunebooks: 10, topKey: 'Dmajor', aliases: [],
    settings: [{ id: id * 10, url: '', key: 'Dmajor', abc: 'ABcd|', member: { id: 1, name: 'x', url: '' }, date: '' }],
  };
}

function folderTree(s: AppState): Record<string, Record<string, string[]>> {
  return Object.fromEntries(s.rootFolderIds.map(fid => {
    const f = s.folders[fid]!;
    return [f.name, Object.fromEntries(f.deckIds.map(did => {
      const d = s.decks[did]!;
      return [d.name, d.entries.map(e => s.cards[e.cardId]!.name)];
    }))];
  }));
}

describe('sample library', () => {
  it('teaches the other language and hides each answer', () => {
    const s = emptyState();
    addDefaultSamples(s, 'fr');
    const tree = folderTree(s);
    expect(Object.keys(tree)).toEqual(['Langue', 'Géographie']);
    expect(tree['Langue']!['Anglais']).toEqual(['Chien', 'Maison', 'Voiture', 'Manger', 'Amour']);
    expect(tree['Géographie']!['Capitales']).toHaveLength(6);
    expect(Object.values(s.cards).every(c => /\|\|.+\|\|/.test(c.content.notes))).toBe(true);

    const en = emptyState();
    addDefaultSamples(en, 'en');
    expect(Object.keys(folderTree(en)['Language']!)).toEqual(['French']);
  });

  it('makes one card of a tune listed in two decks, and a set named after its tunes', () => {
    const s = emptyState();
    addIrishSamples(s, 'fr', irishSampleTuneIds().map(fakeTune));
    normaliseState(s);
    const tree = folderTree(s);
    expect(tree['Sessions']!['Ma session locale']).toEqual(['Tune 64', 'Tune 1', 'Tune 13298', 'Tune 11060', 'Tune 9092']);
    expect(tree['Moi']!['Mon répertoire']).toEqual(['Tune 64', 'Tune 11060', 'Tune 729', 'Tune 1299', 'Tune 64 / Tune 1299 / Tune 729']);
    expect(tree['Moi']!['À apprendre']).toEqual(['Tune 55']);

    // 8 tunes and 1 set, not one card per deck entry.
    expect(Object.keys(s.cards)).toHaveLength(9);
    const set = Object.values(s.cards).find(c => c.type === 'tuneset')!;
    expect(set.computedName).toBe(true);
    expect(set.tunes!.map(r => r.repeat)).toEqual([3, 3, 3]);
    expect(set.content.attachments).toEqual([expect.objectContaining({ generatedBy: 'tuneset' })]);
  });

  it('refuses to build with a tune missing rather than leave a hole', () => {
    const s = emptyState();
    expect(() => addIrishSamples(s, 'en', [fakeTune(64)])).toThrow();
  });
});
