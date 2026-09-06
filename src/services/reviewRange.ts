import type { SessionEntry } from '../types';

// ── The library's "reviewed between" filter ───────────────────────────────────
// Two days in, a yes or no out. Extracted from library.tsx because the only
// hard part is invisible — turning a written day into the instants it actually
// spans — and inline in a render function it could not be tested at all.

export interface ReviewRange {
  /** Inclusive lower bound in epoch ms, or null for an open start. */
  fromTs: number | null;
  /** Inclusive upper bound in epoch ms, or null for an open end. */
  toTs: number | null;
}

/** A day is a day WHERE THE READER IS, and it is 24 hours long.
 *
 *  `new Date('2026-09-03')` is parsed as UTC, so it lands on the 2nd for anyone
 *  west of Greenwich — the kind of off-by-one nobody notices until a review
 *  sits on the wrong side of a boundary. The explicit time is what makes the
 *  string local, and it is the whole reason this function exists rather than
 *  two inline expressions.
 *
 *  The upper bound closes at the last millisecond of its day rather than at the
 *  next midnight, so "3 to 3 September" means that whole day and a review at
 *  23:59:59 is in it.
 *
 *  An unparseable day counts as no bound at all. A range is normally built from
 *  two date pickers, but it also arrives from a URL, and a garbled one must
 *  widen the search rather than silently match nothing — NaN loses every
 *  comparison, so an unguarded bad date would empty the library with no
 *  explanation. */
export function localDayRange(from: string, to: string): ReviewRange {
  const at = (day: string, time: string): number | null => {
    if (!day) return null;
    const ms = new Date(`${day}T${time}`).getTime();
    return Number.isNaN(ms) ? null : ms;
  };
  return { fromTs: at(from, '00:00:00.000'), toTs: at(to, '23:59:59.999') };
}

/** Whether any of these reviews falls inside the range.
 *
 *  ANY review, not the LAST one: the question the filter answers is "what did I
 *  work on that week", and a card revisited since has not stopped being part of
 *  that week's work.
 *
 *  An empty range is not a filter, so everything passes — including a card with
 *  no history at all, which is what lets the caller write one expression
 *  instead of branching on whether the filter is set. */
export function hasReviewInRange(history: SessionEntry[] | undefined, range: ReviewRange): boolean {
  const { fromTs, toTs } = range;
  if (fromTs === null && toTs === null) return true;
  return (history ?? []).some(e =>
    (fromTs === null || e.ts >= fromTs) && (toTs === null || e.ts <= toTs)
  );
}
