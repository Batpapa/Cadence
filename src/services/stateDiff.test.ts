import { describe, it, expect } from 'vitest';
import { statesEqual, diffStates } from './stateDiff';
import type { AppState, SessionRating } from '../types';

function base(): AppState {
  return {
    id: 'u1', name: 'Anne', language: 'fr',
    availabilityThreshold: 0.8, weightByImportance: true, forgettingRate: 1,
    profileIds: ['p1'], currentProfileId: 'p1', profiles: { p1: { id: 'p1', name: 'Défaut' } },
    cards: { c1: { id: 'c1', guid: 'g1', name: 'The Kesh', defaultImportance: 1, tags: [], content: { notes: '', attachments: [] } } },
    decks: { d1: { id: 'd1', name: 'Jigs', entries: [{ cardId: 'c1' }] } },
    cardWorks: { 'p1:c1': { profileId: 'p1', cardId: 'c1', history: [{ ts: 1000, rating: 'good' as SessionRating }] } },
    folders: {}, rootFolderIds: [], rootDeckIds: ['d1'],
  } as AppState;
}
const clone = (s: AppState): AppState => structuredClone(s);

describe('statesEqual — the check that decides whether to interrupt the user', () => {
  it('two independently built copies of the same data are equal', () => {
    expect(statesEqual(base(), base())).toBe(true);
  });

  it('ignores the per-install bookkeeping fields', () => {
    const a = base();
    const b = { ...clone(a), id: 'someone-else', _lastModified: 42, _deviceId: 'x' } as AppState;
    expect(statesEqual(a, b)).toBe(true);
  });

  it('treats a missing optional field and an explicit undefined as the same — a JSON round trip drops it', () => {
    const a = { ...base(), excludeMastered: undefined } as AppState;
    const b = base();                       // key simply absent
    expect(statesEqual(a, b)).toBe(true);
  });

  it('catches a single extra review', () => {
    const a = base(), b = clone(a);
    b.cardWorks['p1:c1']!.history.push({ ts: 2000, rating: 'again' as SessionRating });
    expect(statesEqual(a, b)).toBe(false);
  });

  it('catches a change nowhere near the categories the readable diff knows about', () => {
    const a = base(), b = clone(a);
    b.cards['c1']!.content.attachments = [{ id: 'a1' } as never];
    expect(statesEqual(a, b)).toBe(false);
  });

  it('catches a REORDER, which is a real user choice', () => {
    const a = base(), b = clone(a);
    a.rootDeckIds = ['d1', 'd2']; b.rootDeckIds = ['d2', 'd1'];
    expect(statesEqual(a, b)).toBe(false);
  });

  it('catches an unknown future field the summariser would miss', () => {
    const a = base();
    const b = { ...clone(a), somethingAddedLater: 7 } as unknown as AppState;
    expect(statesEqual(a, b)).toBe(false);
  });
});

describe('diffStates', () => {
  it('reports nothing on identical copies', () => {
    const d = diffStates(base(), base());
    expect(d.summarised).toBe(true);
    expect(d.oneSided).toBeNull();
  });

  it('counts extra reviews per side and dates the most recent one', () => {
    const local = base(), drive = clone(local);
    local.cardWorks['p1:c1']!.history.push({ ts: 5000, rating: 'good' as SessionRating });
    local.cardWorks['p1:c1']!.history.push({ ts: 9000, rating: 'easy' as SessionRating });
    const d = diffStates(local, drive);
    expect(d.reviews.onlyLocal).toBe(2);
    expect(d.reviews.onlyDrive).toBe(0);
    expect(d.reviews.latestOnlyLocal).toBe(9000);
    expect(d.reviews.latestOnlyDrive).toBeNull();
  });

  it('does not invent a difference when one side legitimately holds the same review twice', () => {
    const local = base(), drive = clone(local);
    local.cardWorks['p1:c1']!.history.push({ ts: 1000, rating: 'good' as SessionRating });
    drive.cardWorks['p1:c1']!.history.push({ ts: 1000, rating: 'good' as SessionRating });
    expect(diffStates(local, drive).reviews.onlyLocal).toBe(0);
  });

  it('separates added, removed and modified entities', () => {
    const local = base(), drive = clone(local);
    local.cards['c2'] = { ...local.cards['c1']!, id: 'c2', name: 'Morrison' };
    drive.cards['c3'] = { ...drive.cards['c1']!, id: 'c3', name: 'Cooley' };
    drive.cards['c1']!.name = 'The Kesh Jig';
    const d = diffStates(local, drive);
    expect(d.cards).toEqual({ onlyLocal: ['c2'], onlyDrive: ['c3'], changed: ['c1'] });
  });

  it('flags a one-sided difference — the signature of a lost acknowledgement', () => {
    const local = base(), drive = clone(local);
    local.cardWorks['p1:c1']!.history.push({ ts: 5000, rating: 'good' as SessionRating });
    local.cards['c2'] = { ...local.cards['c1']!, id: 'c2', name: 'Morrison' };
    expect(diffStates(local, drive).oneSided).toBe('local');
  });

  it('refuses the one-sided reading when both sides added something', () => {
    const local = base(), drive = clone(local);
    local.cards['c2'] = { ...local.cards['c1']!, id: 'c2', name: 'Morrison' };
    drive.cards['c3'] = { ...drive.cards['c1']!, id: 'c3', name: 'Cooley' };
    expect(diffStates(local, drive).oneSided).toBeNull();
  });

  it('refuses it too when the additions are one-sided but a shared entity was edited on both', () => {
    const local = base(), drive = clone(local);
    local.cardWorks['p1:c1']!.history.push({ ts: 5000, rating: 'good' as SessionRating });
    drive.cards['c1']!.name = 'renamed on the other side';
    const d = diffStates(local, drive);
    expect(d.oneSided).toBeNull();
    expect(d.cards.changed).toEqual(['c1']);
  });

  it('lists changed settings with both values', () => {
    const local = base(), drive = clone(local);
    drive.availabilityThreshold = 0.5;
    expect(diffStates(local, drive).settings).toEqual([
      { field: 'availabilityThreshold', local: 0.8, drive: 0.5 },
    ]);
  });

  it('counts module entries through their wrapper key', () => {
    const local = base(), drive = clone(local);
    local.modules = { 'tune-analyser': { sessions: { s1: { name: 'a' }, s2: { name: 'b' } } } };
    drive.modules = { 'tune-analyser': { sessions: { s1: { name: 'a' } } } };
    expect(diffStates(local, drive).modules).toEqual([
      { key: 'tune-analyser', onlyLocal: 1, onlyDrive: 0, changed: 0 },
    ]);
  });

  it('summarised is false as soon as any category found something', () => {
    const local = base(), drive = clone(local);
    drive.language = 'en';
    expect(diffStates(local, drive).summarised).toBe(false);
  });
});
