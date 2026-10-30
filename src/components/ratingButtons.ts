import type { SessionRating } from '../types';

// ── The four rating buttons ──────────────────────────────────────────────────
// The study screen's, and the analyses' Focus view's (2026-10-30, the user's
// call: the most familiar way to rate there is). One list, so the two cannot
// drift apart in order, colour or wording.

/** The study screen's grid: one column on a narrow screen, two, then the four
 *  in a row. The Focus view starts from the same widths, and tightens further
 *  when the buttons would run off the screen (DetectionCard's ratingFit). */
export const RATING_GRID = 'grid grid-cols-1 min-[520px]:grid-cols-2 min-[900px]:grid-cols-4 gap-2';

export const RATING_BUTTONS: Array<{ rating: SessionRating; key: string; cls: string; shortcut: string }> = [
  { rating: 'again', key: 'rating.again', cls: 'btn py-2.5 text-sm font-semibold bg-danger/10 hover:bg-danger/20 text-danger',   shortcut: '1' },
  { rating: 'hard',  key: 'rating.hard',  cls: 'btn py-2.5 text-sm font-semibold bg-warn/10 hover:bg-warn/20 text-warn',          shortcut: '2' },
  { rating: 'good',  key: 'rating.good',  cls: 'btn py-2.5 text-sm font-semibold bg-accent/10 hover:bg-accent/20 text-accent',    shortcut: '3' },
  { rating: 'easy',  key: 'rating.easy',  cls: 'btn py-2.5 text-sm font-semibold bg-success/10 hover:bg-success/20 text-success', shortcut: '4' },
];
