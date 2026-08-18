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
   *  inside it — see `filterShortSegments`/`countTop1Windows` in
   *  viterbiDetector.ts. A segment is only trusted once at least this many
   *  of its OWN windows had it as the #1-ranked RAW candidate (not merely
   *  "Viterbi assigned this window to this tune" — a window can be assigned
   *  by hysteresis/transition cost alone without ever topping that window's
   *  own candidate list; requiring rank 1 specifically is a stricter, more
   *  stable confirmation signal, changed from the original "windowCount"
   *  version on explicit user request the same day). A segment that never
   *  reaches this count is relabeled UNKNOWN (then merged with any
   *  now-adjacent UNKNOWN segment). EXCEPTION: while detection is still in
   *  progress (live capture OR an import/recording still streaming windows
   *  in — i.e. viterbiSegmenter.ts's forceFinalizeAll is false), the very
   *  last segment is shown regardless of its current rank-1 count —
   *  explicit user call: showing it and then having it disappear/get
   *  superseded is fine, being permanently invisible is not. It closes NOT
   *  finalized if it never reached the threshold (see viterbiSegmenter.ts's
   *  vanish-cleanup), so it can't be mistaken for a confirmed detection.
   *  Once truly finalized (no more windows will ever arrive), that
   *  exemption no longer applies: a genuinely unconfirmed last segment is
   *  filtered like any other. */
  minSegmentWindows: number;

  /** Post-process (2026-08-15), applied AFTER filterShortSegments — see
   *  `mergeNearbySameTune` in viterbiDetector.ts. Two confirmed "tune
   *  results" for the SAME tuneId, separated by fewer than this many
   *  windows (of UNKNOWN, or nothing at all), are merged into one
   *  continuous segment instead of showing as two separate detections — a
   *  brief drop to UNKNOWN mid-tune (a couple of quiet/noisy windows)
   *  shouldn't split one real performance in two. Explicit user request. */
  sameTuneMergeGapWindows: number;

  /** Pre-Viterbi post-process (2026-08-18), applied BEFORE `buildTemporalTimeline`
   *  — see `filterFlatWindows` in temporalObservationBuilder.ts. A window
   *  whose top-1 raw candidate doesn't beat its own topN-th candidate by at
   *  least `flatWindowMarginThreshold` is "flat" (FolkFriend has no clear
   *  opinion — grew out of the 2026-08-17 noise-signature study: a
   *  top1-vs-topN-th margin near zero is the single strongest statistical
   *  signal separating real tunes from background noise, stronger than the
   *  raw top1 score itself) and is stripped of all candidates, contributing
   *  no evidence for or against any tune that window.
   *
   *  Origin of these two values, A/B tested (2026-08-18) on a batch backtest
   *  across 6 real annotated sessions + 1 dedicated pure-noise recording
   *  (same methodology as segmenterConfig.ts's old threshold sweeps):
   *   - topN=2 (bare top1-vs-top2) was tried first and rejected: it wrongly
   *     gutted a real, correct detection ("The Road to Lisdoonvarna" in the
   *     "Tocane" session) because the tune index contains TWO different
   *     tuneIds sharing that exact title (a reel and an unrelated slide)
   *     that score identically almost every window — a legitimate
   *     "ambiguous between two right answers" case that a bare top1-top2
   *     margin cannot distinguish from real noise.
   *   - topN=3 tolerates that kind of near-duplicate/homonym entry (there's
   *     essentially never a THIRD unrelated tune tied for a real detection)
   *     while still catching noise just as well. Swept `flatWindowMarginThreshold`
   *     from 1% to 30% at topN=3: 3% is the highest value with ZERO recall
   *     loss across all 6 sessions (312 ground-truth tunes) for -12.5% false
   *     positives (96→84); 5% (the value adopted here) costs exactly ONE
   *     tune — the same "Road to Lisdoonvarna" homonym-collision case, now
   *     understood to be a structural index quirk rather than a detection
   *     failure — for -20% false positives (96→77). Beyond ~10% losses
   *     accelerate sharply for rapidly diminishing FP gains (e.g. 30% loses
   *     116/312 real tunes), and past ~20% false positives can even tick
   *     back UP (windows emptied out of real music get partly refilled by
   *     other spurious candidates) — never raise these values without
   *     re-running that sweep. */
  flatWindowTopN: number;
  flatWindowMarginThreshold: number;

  /** Pre-Viterbi post-process (2026-08-18), applied AFTER filterFlatWindows —
   *  see `filterByTempoSpread` in temporalObservationBuilder.ts. A window
   *  whose 36 tempo-candidate scores (WindowResult.debug.features.tempo_candidates,
   *  60-240 BPM step 5 — computed by FolkFriend for every window regardless,
   *  previously discarded down to just the winning tempo) have a standard
   *  deviation below this threshold is "tempo-agnostic" — the contour matches
   *  almost equally well no matter which tempo is tried, which real tunes
   *  essentially never are. Requires `WindowResult.debug` to be populated
   *  (ffWorker.ts calling the `_debug` WASM exports, vendored 2026-08-18);
   *  windows without it are left untouched, never flattened for lack of data.
   *
   *  Grew directly out of investigating the known recurring false-positive
   *  "attractors" (romanian fantasy, michael's lament, out the door and over
   *  the wall, ...) from the 2026-08-17/18 noise study: their tempo-candidate
   *  spread is dramatically lower than either other false positives or real
   *  music (mean std 0.14 vs 0.24 vs 0.35 across the 6-session dataset), and
   *  the gap holds even restricted to high-score (>=0.4) false positives
   *  (0.15 vs 0.25), where it's the margin filter above that struggles most.
   *
   *  A/B tested (2026-08-18) STACKED on top of the already-wired margin
   *  filter, across the same 6 sessions (312 ground-truth tunes) + noise
   *  fixture: with the margin filter alone, 12 known-attractor false
   *  positives still got through. Sweeping this threshold: 0.08-0.10 removes
   *  most of them (12→6→4) for ZERO additional recall loss; 0.12 (the value
   *  adopted here) costs exactly one tune ("sport") for 12→2 (-83%). Beyond
   *  ~0.15 the known-attractor count plateaus at 2 (a hard residual this
   *  signal alone doesn't reach) while general recall loss accelerates
   *  sharply (7 lost by 0.18, 15 by 0.20, 64 by 0.30) — never raise past 0.12
   *  without re-running that sweep and confirming the plateau has moved. */
  tempoSpreadThreshold: number;
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
  sameTuneMergeGapWindows: 10,

  flatWindowTopN: 3,
  flatWindowMarginThreshold: 0.05,

  tempoSpreadThreshold: 0.12,
};
