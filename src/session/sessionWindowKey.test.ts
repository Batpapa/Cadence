import { describe, it, expect } from 'vitest';
import { sessionWindowKey } from './db';

// One IndexedDB row per analysis window (2026-09-17). Recovery reads them back
// with a key range, in KEY order — which is string order, so the index has to
// be padded for string order to be window order. Without it, window 10 sorts
// before window 9 and the replay feeds Viterbi a scrambled timeline.

const ID = '0b6f8e2c-3a1d-4f5e-9c7b-2d8a1e6f4b3c';

describe('sessionWindowKey', () => {
  it('sorts as strings in window order, across digit-count boundaries', () => {
    const indices = [0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10000, 123456];
    const keys = indices.map(i => sessionWindowKey(ID, i));
    expect([...keys].sort()).toEqual(keys);
  });

  it('falls inside the session range, and the legacy bare-id key does not', () => {
    const low = `${ID}#`;
    const high = `${ID}#\uffff`;
    for (const i of [0, 1, 4000, 99_999_999]) {
      const key = sessionWindowKey(ID, i);
      expect(key > low && key < high).toBe(true);
    }
    // The pre-2026-09-17 whole-array row lives under the bare id: a range read
    // must not return it as if it were a window.
    expect(ID < low).toBe(true);
  });
});
