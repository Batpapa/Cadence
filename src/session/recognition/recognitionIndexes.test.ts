import { describe, expect, it } from 'vitest';
import { recognitionIndexesOf, recognitionPlan, storedRecognitionIndexes } from './recognitionIndexes';
import { TUNE_ANALYSER_MODULE_KEY } from '../model';

const user = (recognitionIndexes?: { id: string; on: boolean }[]) =>
  ({ modules: { [TUNE_ANALYSER_MODULE_KEY]: { sessions: {}, ...(recognitionIndexes ? { recognitionIndexes } : {}) } } });

describe('recognitionIndexesOf', () => {
  // The user's default (2026-11-16): cards, then TheSession, both on.
  it('reads nothing stored as cards then TheSession, both on', () => {
    expect(recognitionIndexesOf({})).toEqual([{ id: 'cards', on: true }, { id: 'thesession', on: true }]);
    expect(recognitionIndexesOf(user())).toEqual([{ id: 'cards', on: true }, { id: 'thesession', on: true }]);
  });

  it('keeps the stored order and switches, and adds what it does not name', () => {
    expect(recognitionIndexesOf(user([{ id: 'thesession', on: true }, { id: 'cards', on: false }])))
      .toEqual([{ id: 'thesession', on: true }, { id: 'cards', on: false }]);
    expect(recognitionIndexesOf(user([{ id: 'thesession', on: false }])))
      .toEqual([{ id: 'thesession', on: false }, { id: 'cards', on: true }]);
  });

  it('ignores an index it does not know, and never reads all off', () => {
    expect(recognitionIndexesOf(user([{ id: 'baloche', on: true }, { id: 'cards', on: true }])))
      .toEqual([{ id: 'cards', on: true }, { id: 'thesession', on: true }]);
    expect(recognitionIndexesOf(user([{ id: 'cards', on: false }, { id: 'thesession', on: false }])))
      .toEqual([{ id: 'cards', on: true }, { id: 'thesession', on: true }]);
  });
});

describe('storedRecognitionIndexes', () => {
  // A newer version's index must survive an older one saving its own list.
  it('writes every switch, and keeps the entries it does not know after them', () => {
    const u = user([{ id: 'baloche', on: false }, { id: 'cards', on: true }]);
    expect(storedRecognitionIndexes(u, [{ id: 'thesession', on: true }, { id: 'cards', on: false }]))
      .toEqual([{ id: 'thesession', on: true }, { id: 'cards', on: false }, { id: 'baloche', on: false }]);
  });
});

describe('recognitionPlan', () => {
  it('loads what is on, and orders the sources as the list does', () => {
    expect(recognitionPlan([{ id: 'cards', on: true }, { id: 'thesession', on: true }]))
      .toEqual({ cards: true, theSession: true, sourceOrder: ['cards', 'thesession'] });
    expect(recognitionPlan([{ id: 'thesession', on: true }, { id: 'cards', on: true }]))
      .toEqual({ cards: true, theSession: true, sourceOrder: ['thesession', 'cards'] });
    expect(recognitionPlan([{ id: 'thesession', on: false }, { id: 'cards', on: true }]))
      .toEqual({ cards: true, theSession: false, sourceOrder: ['cards'] });
  });
});
