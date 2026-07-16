// ── Recognition aggregator tuning ─────────────────────────────────────────────
// All calibratable constants live here. Adjust after testing on real recordings.

export const AGG_CONFIG = {
  /** Below this top-1 score the window is treated as empty. */
  SCORE_FLOOR: 0.45,
  /** Minimal top1−top2 margin for a window to count as a clear win. */
  MARGIN_MIN: 0.04,
  /** Consecutive wins required to confirm a tune (open an annotation). */
  K_CONFIRM: 2,
  /** Consecutive wins by a rival before switching tunes (set segmentation). */
  K_SWITCH: 2,
  /** Consecutive empty/weak windows before closing the current tune. */
  K_EMPTY_CLOSE: 4,
  /** Consecutive empty windows that reset an unconfirmed candidate. */
  K_EMPTY_CANDIDATE_RESET: 2,
  /** Confidence bucket thresholds. */
  BUCKET_HIGH: 0.7,
  BUCKET_MEDIUM: 0.5,
  /** Number of alternate candidates kept on an annotation. */
  MAX_ALTERNATES: 3,
} as const;

export type AggConfig = typeof AGG_CONFIG;
