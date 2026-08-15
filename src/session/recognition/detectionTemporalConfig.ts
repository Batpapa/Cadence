// ── Temporal detection tuning (V1: fixed-cost Viterbi) ────────────────────────
// See temporalObservationBuilder.ts / viterbiDetector.ts. All values below are
// the initial suggestions from the 2026-08-13 spec, not calibrated — to be
// tuned against real recordings, same methodology as segmenterConfig.ts.

export interface DetectionTemporalConfig {
  /** Seconds between consecutive analysis windows. */
  stepSeconds: number;
  /** Seconds spanned by a single analysis window (informational — the
   *  detector works entirely off window start times + stepSeconds, see
   *  viterbiDetector.ts's windowRangeToTime; kept here for documentation and
   *  for any future scoring that wants to reason about window duration). */
  windowSeconds: number;

  /** A tuneId never scoring at least this well anywhere in the recording is
   *  dropped from the candidate set entirely (not just zeroed per-window) —
   *  keeps the Viterbi state space to only what the recognizer ever actually
   *  suggested with some confidence. Does NOT zero out individual weak
   *  windows for a tune that clears this bar elsewhere. */
  minCandidateProbability: number;
  /** Floor applied before taking a log, so an absent-this-window probability
   *  of 0 doesn't produce -Infinity. */
  epsilon: number;

  /** V1.1 (2026-08-14): UNKNOWN's assumed observation probability, constant
   *  across every window — put through the SAME observationScoreFn as every
   *  real tune. Replaces the original log(1 - maxProbability) formula: the
   *  recognizer's score isn't a calibrated probability, so treating 1-p as
   *  "probability of UNKNOWN" doesn't hold, and it backtested badly — it set
   *  an implicit 50% bar (1-p > p whenever p<0.5) that a lot of genuinely
   *  correct detections never clear (real tunes routinely score 0.30-0.50).
   *  To retune: sweep 0.15/0.20/0.25/0.30 against the ground-truth backtests
   *  and compare recall/precision, same methodology as segmenterConfig.ts. */
  unknownObservationProbability: number;

  /** Cost of staying on the same tune between consecutive windows. */
  sameTuneTransitionCost: number;
  /** Cost of switching from one real tune to a different real tune. */
  tuneChangePenalty: number;

  /** Cost of staying in UNKNOWN between consecutive windows. */
  unknownStayPenalty: number;
  /** Cost of leaving a tune for UNKNOWN. */
  tuneToUnknownPenalty: number;
  /** Cost of leaving UNKNOWN for a tune. */
  unknownToTunePenalty: number;

  /** Extra cost added on top of tuneChangePenalty when a switch immediately
   *  reverses the previous switch (A -> B -> A across two windows) — the
   *  specific bounce-back case, not general flapping over a longer span. */
  rapidChangePenalty: number;

  /** V1: observationScore(p) = log(max(p, epsilon)). Pluggable so a V2 can
   *  swap in f(probability, rank) without touching the detector itself —
   *  rank is already carried through TemporalTimeline for exactly this. */
  observationScoreFn?: (probability: number, epsilon: number) => number;

  /** Confidence bucket thresholds for the UI badge (formerly segmenterConfig.ts's
   *  BUCKET_HIGH/BUCKET_MEDIUM). */
  bucketHighConfidence: number;
  bucketMediumConfidence: number;
  /** Number of alternate candidates kept on an annotation besides the current
   *  pick (formerly segmenterConfig.ts's MAX_ALTERNATES). */
  maxAlternates: number;

  /** Used by viterbiSegmenter.ts's incremental wrapper to decide when a
   *  segment is safe from future revision. UNLIKE segmenterConfig.ts's old
   *  MAX_GAP_WINDOWS (a PROVEN bound, from purely local hysteresis, on how far
   *  back a new window could touch history), this is an EMPIRICAL heuristic:
   *  Viterbi is a global decode, so there's no formal guarantee a distant
   *  future window can never revise an old decision. The 2026-08-15
   *  revision-lag probe (replayed all 4 annotated real sessions as growing
   *  prefixes, ~60 checkpoints each, comparing every prefix's decoded state
   *  per window against the full-session final state) found the disagreement
   *  NEVER reached more than 0 windows back from the prefix's own last
   *  window — i.e., in every real case observed, only the most recent window
   *  was ever still "undecided." This value is a precautionary margin on top
   *  of that (0 measured), not a value the data required. */
  finalizationLagSeconds: number;

  /** Post-process (2026-08-15), applied AFTER the Viterbi decode, never
   *  inside it — see `filterShortSegments` in viterbiDetector.ts. A non-UNKNOWN
   *  segment covered by fewer than this many windows is relabeled UNKNOWN
   *  (then merged with any now-adjacent UNKNOWN segment) — a single stray
   *  window winning against the tuneChangePenalty is weaker evidence than a
   *  run that persists. EXCEPTION: while detection is still in progress
   *  (live capture OR an import/recording still streaming windows in — i.e.
   *  viterbiSegmenter.ts's forceFinalizeAll is false), the very last segment
   *  is shown regardless of its current windowCount — explicit user call:
   *  showing it and then having it disappear/get superseded is fine, being
   *  permanently invisible is not. It closes NOT finalized if it never
   *  reached the threshold (see viterbiSegmenter.ts's vanish-cleanup), so it
   *  can't be mistaken for a confirmed detection. Once truly finalized (no
   *  more windows will ever arrive), that exemption no longer applies: a
   *  genuinely short last segment is filtered like any other. */
  minSegmentWindows: number;
}

export const DETECTION_TEMPORAL_CONFIG: DetectionTemporalConfig = {
  stepSeconds: 5,
  windowSeconds: 15,

  minCandidateProbability: 0.20,
  epsilon: 0.000001,
  unknownObservationProbability: 0.25,

  sameTuneTransitionCost: 0,
  tuneChangePenalty: 1.0,

  unknownStayPenalty: 0.2,
  tuneToUnknownPenalty: 0.5,
  unknownToTunePenalty: 0.5,

  rapidChangePenalty: 2.0,

  bucketHighConfidence: 0.5,
  bucketMediumConfidence: 0.3,
  maxAlternates: 4,

  finalizationLagSeconds: 30,

  minSegmentWindows: 2,
};
