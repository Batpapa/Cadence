import { describe, it, expect } from 'vitest';
import { localDayRange, hasReviewInRange } from './reviewRange';
import type { SessionEntry } from '../types';

// The filter is one line in the library; the part worth testing is the one that
// is invisible there — a written day is not an instant, and turning one into
// the other is where an off-by-one day hides.

const at = (...args: [number, number, number, number?, number?, number?, number?]) => new Date(...args).getTime();
const review = (ts: number): SessionEntry => ({ ts, rating: 'good' });

describe('localDayRange', () => {
  // The whole reason the function exists: `new Date('2026-09-03')` is UTC and
  // lands on the 2nd west of Greenwich. These bounds are built from local
  // components, so they hold wherever the test runs.
  it('starts a day at LOCAL midnight, not UTC', () => {
    expect(localDayRange('2026-09-03', '').fromTs).toBe(at(2026, 8, 3, 0, 0, 0, 0));
  });

  it('ends a day at its last millisecond, so the whole day is in it', () => {
    expect(localDayRange('', '2026-09-03').toTs).toBe(at(2026, 8, 3, 23, 59, 59, 999));
  });

  it('spans exactly 24 hours for a single day', () => {
    const { fromTs, toTs } = localDayRange('2026-09-03', '2026-09-03');
    expect(toTs! - fromTs!).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it('leaves an unset end open', () => {
    expect(localDayRange('2026-09-03', '')).toEqual({ fromTs: at(2026, 8, 3, 0, 0, 0, 0), toTs: null });
    expect(localDayRange('', '2026-09-03')).toEqual({ fromTs: null, toTs: at(2026, 8, 3, 23, 59, 59, 999) });
    expect(localDayRange('', '')).toEqual({ fromTs: null, toTs: null });
  });

  // A range normally comes from two date pickers, but it also arrives from a
  // URL. NaN loses every comparison, so an unguarded bad date would empty the
  // library with nothing to explain it — widening beats matching nothing.
  it('treats an unreadable day as no bound at all', () => {
    expect(localDayRange('not-a-day', 'neither')).toEqual({ fromTs: null, toTs: null });
    expect(localDayRange('2026-13-45', '')).toEqual({ fromTs: null, toTs: null });
  });

  // Days the calendar does not have. A month rolls over rather than producing a
  // bound nothing can fall inside.
  it('does not invent an impossible instant for 31 September', () => {
    const { fromTs } = localDayRange('2026-09-31', '');
    expect(fromTs).toBe(at(2026, 9, 1, 0, 0, 0, 0)); // 1 October
  });
});

describe('hasReviewInRange', () => {
  const inside = review(at(2026, 8, 3, 12, 0));
  const before = review(at(2026, 8, 2, 12, 0));
  const after = review(at(2026, 8, 4, 12, 0));

  it('finds a review inside the range', () => {
    expect(hasReviewInRange([inside], localDayRange('2026-09-03', '2026-09-03'))).toBe(true);
    expect(hasReviewInRange([before, after], localDayRange('2026-09-03', '2026-09-03'))).toBe(false);
  });

  // ANY review, not the last: a card revisited since has not stopped being part
  // of that week's work.
  it('matches on any review, not only the most recent', () => {
    expect(hasReviewInRange([inside, after], localDayRange('2026-09-03', '2026-09-03'))).toBe(true);
  });

  it('includes both edges of the day', () => {
    const range = localDayRange('2026-09-03', '2026-09-03');
    expect(hasReviewInRange([review(at(2026, 8, 3, 0, 0, 0, 0))], range)).toBe(true);
    expect(hasReviewInRange([review(at(2026, 8, 3, 23, 59, 59, 999))], range)).toBe(true);
    expect(hasReviewInRange([review(at(2026, 8, 4, 0, 0, 0, 0))], range)).toBe(false);
  });

  it('honours an open end', () => {
    expect(hasReviewInRange([after], localDayRange('2026-09-03', ''))).toBe(true);
    expect(hasReviewInRange([before], localDayRange('2026-09-03', ''))).toBe(false);
    expect(hasReviewInRange([before], localDayRange('', '2026-09-03'))).toBe(true);
    expect(hasReviewInRange([after], localDayRange('', '2026-09-03'))).toBe(false);
  });

  // No range is no filter — including for a card nobody has ever reviewed,
  // which is what lets the caller write one expression instead of branching.
  it('lets everything through when no range is set', () => {
    const none = localDayRange('', '');
    expect(hasReviewInRange([], none)).toBe(true);
    expect(hasReviewInRange(undefined, none)).toBe(true);
  });

  it('excludes a card with no reviews as soon as a range is set', () => {
    const range = localDayRange('2026-09-03', '');
    expect(hasReviewInRange([], range)).toBe(false);
    expect(hasReviewInRange(undefined, range)).toBe(false);
  });
});
