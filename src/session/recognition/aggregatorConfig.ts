// ── Recognition aggregator tuning ─────────────────────────────────────────────
// All calibratable constants live here. Adjust after testing on real recordings.

export interface AggConfig {
  SCORE_FLOOR: number;
  MARGIN_MIN: number;
  K_CONFIRM: number;
  K_SWITCH: number;
  K_EMPTY_CLOSE: number;
  K_EMPTY_CANDIDATE_RESET: number;
  BUCKET_HIGH: number;
  BUCKET_MEDIUM: number;
  MAX_ALTERNATES: number;
}

export const AGG_CONFIG: AggConfig = {
  /** Below this top-1 score the window is treated as empty.
   *  Calibrated 2026-07 on a real pub session: true tunes routinely top out at
   *  0.41-0.48 while junk never exceeded 0.40 twice in a row (K_CONFIRM filters
   *  the singletons). 0.45 lost Kilty Town (0.449!) and Plains of Boyle. */
  SCORE_FLOOR: 0.40,
  /** Minimal top1−top2 margin for a window to count as a clear win. */
  MARGIN_MIN: 0.04,
  /** Wins required to confirm a tune (open an annotation). Not necessarily
   *  consecutive: pub recordings recognise ~1 window in 3-5 while a tune plays,
   *  so repeated hits on the same tune across empty windows count. */
  K_CONFIRM: 2,
  /** Consecutive wins by a rival before switching tunes (set segmentation). */
  K_SWITCH: 2,
  /** Consecutive empty/weak windows before closing the current tune.
   *  Calibrated 2026-07: 4 (20 s) fragmented tunes mid-play (Old Joe's, Loftus
   *  Jones split in 2-3); end timestamps don't suffer from a high value since
   *  the close uses the start of the empty run. */
  K_EMPTY_CLOSE: 10,
  /** Empty windows tolerated before an unconfirmed candidate is dropped.
   *  Calibrated 2026-07: 2 killed real tunes recognised sporadically
   *  (The Flogging: 3 correct hits 25 s apart, never 2 consecutive). */
  K_EMPTY_CANDIDATE_RESET: 8,
  /** Confidence bucket thresholds. */
  BUCKET_HIGH: 0.7,
  BUCKET_MEDIUM: 0.5,
  /** Number of alternate candidates kept on an annotation. */
  MAX_ALTERNATES: 3,
};
