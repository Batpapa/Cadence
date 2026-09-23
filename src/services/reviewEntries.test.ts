import { describe, it, expect } from 'vitest';
import type { SessionEntry } from '../types';
import { reviewEntryIndex, retargetedHistory, movedReviewEntry, strippedReviewIds } from './reviewEntries';

// The id is opaque here — these are the mechanics of a history whose entries
// may be owned by something that outlives the giving of the rating. See
// reviewEntries.ts, and session/reviewLink.ts for the one owner there is today.

const T0 = Date.parse('2026-09-12T20:30:00.000Z');
const entry = (ts: number, rating: SessionEntry['rating'] = 'good', id?: string): SessionEntry =>
  id ? { ts, rating, id } : { ts, rating };

describe('reviewEntryIndex', () => {
  it('finds the entry by its id, wherever its instant has moved to', () => {
    const history = [entry(T0), entry(T0 + 999_999, 'hard', 'a')];
    expect(reviewEntryIndex(history, 'a', T0 + 60_000)).toBe(1);
  });

  it('falls back to the instant for an entry filed before ids existed', () => {
    expect(reviewEntryIndex([entry(T0 + 1_000), entry(T0 + 60_000)], 'a', T0 + 60_000)).toBe(1);
  });

  // Two detections of one tune can end at the same instant after a merge, and
  // a rating given elsewhere can land on one by coincidence.
  it('never claims an entry that carries someone else’s id', () => {
    expect(reviewEntryIndex([entry(T0 + 60_000, 'good', 'b')], 'a', T0 + 60_000)).toBe(-1);
  });

  it('finds nothing without an instant to look at, when no id matches', () => {
    expect(reviewEntryIndex([entry(T0 + 60_000)], 'a', null)).toBe(-1);
  });
});

describe('retargetedHistory', () => {
  it('moves the entry to the new instant and leaves the rest alone', () => {
    const before = [entry(T0 + 1_000, 'again'), entry(T0 + 60_000, 'good', 'a'), entry(T0 + 900_000)];
    expect(retargetedHistory(before, 'a', null, { id: 'a', ts: T0 + 64_250 })).toEqual([
      entry(T0 + 1_000, 'again'),
      entry(T0 + 64_250, 'good', 'a'),
      entry(T0 + 900_000),
    ]);
  });

  it('stamps the id onto a legacy entry it moves', () => {
    expect(retargetedHistory([entry(T0 + 60_000, 'hard')], 'a', T0 + 60_000, { id: 'a', ts: T0 + 61_000 }))
      .toEqual([entry(T0 + 61_000, 'hard', 'a')]);
  });

  it('keeps the history sorted when the new instant lands elsewhere in it', () => {
    const before = [entry(T0 + 10_000, 'good', 'a'), entry(T0 + 20_000, 'easy')];
    expect(retargetedHistory(before, 'a', null, { id: 'a', ts: T0 + 30_000 })?.map(e => e.ts))
      .toEqual([T0 + 20_000, T0 + 30_000]);
  });

  it('is a no-op when the entry is already where it is asked to go', () => {
    const before = [entry(T0 + 60_000, 'good', 'a')];
    expect(retargetedHistory(before, 'a', null, { id: 'a', ts: T0 + 60_000 })).toBeNull();
  });

  it('is a no-op when nothing was ever filed under that id', () => {
    expect(retargetedHistory([entry(T0 + 1_000)], 'a', T0 + 60_000, { id: 'a', ts: T0 + 64_000 })).toBeNull();
  });

  it('re-attributes the entry to another id', () => {
    expect(retargetedHistory([entry(T0 + 60_000, 'hard', 'a')], 'a', null, { id: 'b', ts: T0 + 120_000 }))
      .toEqual([entry(T0 + 120_000, 'hard', 'b')]);
  });

  // Both detections of a merge were rated: one tune played once, one review.
  it('drops the moved entry when the destination id already has one', () => {
    const before = [entry(T0 + 60_000, 'hard', 'a'), entry(T0 + 120_000, 'easy', 'b')];
    expect(retargetedHistory(before, 'a', null, { id: 'b', ts: T0 + 120_000 }))
      .toEqual([entry(T0 + 120_000, 'easy', 'b')]);
  });

  it('removes the entry when asked for no destination', () => {
    expect(retargetedHistory([entry(T0 + 1_000), entry(T0 + 60_000, 'good', 'a')], 'a', null, null))
      .toEqual([entry(T0 + 1_000)]);
  });

  it('does not mutate the history it was given', () => {
    const before = [entry(T0 + 60_000, 'good', 'a')];
    retargetedHistory(before, 'a', null, { id: 'a', ts: T0 + 61_000 });
    expect(before).toEqual([entry(T0 + 60_000, 'good', 'a')]);
  });
});

describe('movedReviewEntry', () => {
  it('takes the entry out of one history and files it in the other', () => {
    const from = [entry(T0, 'again'), entry(T0 + 60_000, 'easy', 'a')];
    const to = [entry(T0 + 10_000, 'good')];
    expect(movedReviewEntry(from, to, 'a', null)).toEqual({
      from: [entry(T0, 'again')],
      to: [entry(T0 + 10_000, 'good'), entry(T0 + 60_000, 'easy', 'a')],
    });
  });

  it('carries a legacy entry over, stamped', () => {
    expect(movedReviewEntry([entry(T0 + 60_000, 'hard')], [], 'a', T0 + 60_000)).toEqual({
      from: [],
      to: [entry(T0 + 60_000, 'hard', 'a')],
    });
  });

  it('drops the entry when there is no destination history', () => {
    expect(movedReviewEntry([entry(T0 + 60_000, 'good', 'a')], null, 'a', null))
      .toEqual({ from: [], to: null });
  });

  it('writes nothing when the destination already carries this id', () => {
    const to = [entry(T0 + 60_000, 'easy', 'a')];
    expect(movedReviewEntry([entry(T0 + 60_000, 'good', 'a')], to, 'a', null))
      .toEqual({ from: [], to: null });
  });

  it('is a no-op when the source history has nothing under that id', () => {
    expect(movedReviewEntry([entry(T0)], [], 'a', null)).toBeNull();
  });
});

describe('strippedReviewIds', () => {
  it('keeps the ratings and drops only the ids that match', () => {
    const before = [entry(T0 + 60_000, 'good', 'gone:1'), entry(T0 + 90_000, 'easy', 'kept:1'), entry(T0 + 120_000, 'hard')];
    expect(strippedReviewIds(before, id => id.startsWith('gone:'))).toEqual([
      entry(T0 + 60_000, 'good'),
      entry(T0 + 90_000, 'easy', 'kept:1'),
      entry(T0 + 120_000, 'hard'),
    ]);
  });

  it('is a no-op when nothing matches', () => {
    expect(strippedReviewIds([entry(T0, 'good', 'kept:1')], id => id.startsWith('gone:'))).toBeNull();
  });
});
