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
   *
   *  SWEPT 0.15 -> 0.30 (step 0.01) on 2026-09-06 over 7 annotated sessions
   *  (319 ground-truth tunes) plus the pure-noise recording, and LOWERED from
   *  0.25 to 0.20 — see experiments/threshold-sweep/. It buys 6 real tunes for
   *  4 false positives (0.25: 281/41, 0.20: 287/45), so it is a judgement call
   *  rather than an optimum, settled on the user's explicit reasoning: a false
   *  positive is VISIBLE in the session list and dismissed in a click, while a
   *  missed tune is invisible and was the complaint that prompted the sweep.
   *  0.20 is also the knee — below it recall stops improving.
   *
   *  Two things that sweep established and that must survive any retune:
   *   - the pure-noise recording yields ZERO detections at EVERY value here,
   *     so this floor is NOT what defends against noise (the flat-window and
   *     tempo-spread filters below are). Lowering it does not weaken that.
   *   - the real limit is that this compares an ABSOLUTE score. Accompaniment
   *     degrades the contour, so a correctly identified tune can sit at
   *     0.17-0.25 for its whole run while still topping every window by a
   *     healthy margin — see observationScoreFn, which exists so a V2 can
   *     score on rank/margin instead and move the curve rather than walk it. */
  unknownObservationProbability: number;

  /** What a tune scores in a window where it is NOT among the candidates, as a
   *  fraction of `unknownObservationProbability` (2026-09-13). Absent means
   *  log(epsilon) = −13.8: one missing window then outweighs dozens of rank-1
   *  windows, so intermittent evidence (a tune ranked first every other window,
   *  typical under accompaniment) could never hold a segment together and was
   *  cut into fragments that minSegmentWindows then discarded.
   *
   *  THRESHOLD LAW — never set this at or above e^(−unknownStayPenalty)
   *  (0.819 with 0.2). Past it, idling "inside" a tune across a window where it
   *  is absent costs less than idling in UNKNOWN, and detections spread over the
   *  gaps between tunes: measured at 0.85-0.95, the start of a detection lands
   *  65-88 s too early at the 90th percentile. If unknownStayPenalty is ever
   *  retuned, move this with it (keep −log(ratio) above it with some margin).
   *
   *  ONLY AFTER ADMISSION. A tune's absence is cheap only from the window it was
   *  first admitted (first score ≥ minCandidateProbability); before that it scores
   *  the plain epsilon floor, observations ignored — see admissionIndex in
   *  viterbiDetector.ts. That rule is what keeps StreamingViterbiDecoder (the one
   *  production runs) byte-identical to a from-scratch decode: without it, a late
   *  tune's cheap pre-admission history made the two diverge. Measured cost: IoU
   *  −0.2 point, recall and false positives unchanged.
   *
   *  0.8 is the current optimum, from the 2026-09-13 ranking study
   *  (experiments/ranking-study/CAMPAIGN_V3.md): on 7 annotated sessions, with
   *  the engine parameters in sessionConfig.ts, 318/341 tunes for 12 false
   *  positives and a mean IoU of 88.0 % (production before: 311, 20, 79.5 %) —
   *  measured on windows regenerated by the production engine itself, through
   *  this decoder — and confirmed on held-out sessions. Coverage alone would have picked 0.95 — it
   *  cannot see a detection spilling into the previous tune; judge on IoU.
   *  Optional: undefined keeps the plain epsilon floor. */
  absentObservationRatio?: number;

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
  /** Number of alternate candidates kept on a detection besides the current
   *  pick (formerly segmenterConfig.ts's MAX_ALTERNATES). */
  maxAlternates: number;

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
   *  now-adjacent UNKNOWN segment). EXCEPTION: the very last segment is
   *  shown regardless of its current rank-1 count — explicit user call:
   *  showing it and then having it disappear/get superseded is fine, being
   *  permanently invisible is not. Superseded while windows still stream in,
   *  it closes NOT finalized (see viterbiSegmenter.ts's vanish-cleanup). It
   *  also survives finalize() since 2026-10-26: people press Stop the moment
   *  their tune appears, and the final pass used to take it away. */
  minSegmentWindows: number;
  /** The live tail's "clear window" rule (2026-11-07). The most recent segment
   *  is exempt from minSegmentWindows (see above) — it is what the screen names
   *  as playing now. With these set, it is shown only once ONE of its windows
   *  named it clearly: at the top of that window's candidates (ties within
   *  0.005 allowed) and ahead of the best other candidate by at least
   *  `tailClearLead`, or ahead of the THIRD candidate by at least
   *  `tailClearLeadOverThird` (two index entries of one air — The Scholar /
   *  The South Shore — tie in every window, and neither would ever lead the
   *  other). Until then the screen names nothing rather than a guess; the
   *  decode itself is untouched.
   *
   *  Why: the windows that put a WRONG name on screen for a few seconds
   *  mid-tune had a lead over #2 of 0.048 (median; q25 0.030), those that put
   *  the RIGHT name up 0.180 (q25 0.117). Those wrong names exist only at the
   *  live edge — the decoder revises them away one window later, so no
   *  transition cost (rapidChangePenalty included) can see them.
   *  Measured with the translated penalties below, two-fold cross-validated
   *  (experiments kept outside the repo): same tunes found, wrong name on
   *  screen 6.9 % of tune time instead of 11.9 %, right name 1.5-2 s sooner.
   *  Undefined = no rule (the previous engine). */
  tailClearLead?: number;
  tailClearLeadOverThird?: number;

  /** Post-process (2026-08-15), applied AFTER filterShortSegments — see
   *  `mergeNearbySameTune` in viterbiDetector.ts. Two confirmed "tune
   *  results" for the SAME tuneId, separated by fewer than this many
   *  windows (of UNKNOWN, or nothing at all), are merged into one
   *  continuous segment instead of showing as two separate detections — a
   *  brief drop to UNKNOWN mid-tune (a couple of quiet/noisy windows)
   *  shouldn't split one real performance in two. Explicit user request.
   *
   *  Also used (2026-08-21) by viterbiSegmenter.ts to decide when a segment
   *  is safe to finalize: Viterbi's own raw state path can be proven stable
   *  via ViterbiResult.convergedThroughIndex, but a same-tune merge could
   *  still reach back into a segment from a NEW segment appearing up to this
   *  many windows later — so finality additionally requires convergence to
   *  reach that far past the segment's own last window. */
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
   *  without re-running that sweep and confirming the plateau has moved.
   *
   *  OFF since 2026-11-08 (0: no window has a negative spread). That sweep was
   *  the previous engine's; on the pitch-class engine the filter no longer
   *  earns its keep — on the 18 annotated files, 0.12 against 0: 675/698 tunes
   *  for 14 false positives against 678 for 16, noise 0 either way — and it
   *  emptied the windows of a tenor banjo playing an octave down: a plucked
   *  instrument's pitch-class transcription often fits every tempo about as
   *  well, and a tune top of 17 windows out of 21 was never shown (reported by
   *  the user). The filter stays in temporalObservationBuilder.ts for the
   *  experiments that measure it. */
  tempoSpreadThreshold: number;

  /** The pitch split (2026-11-08, pitchSplit.ts), run on each tune segment after
   *  the same-tune merge: a detection is cut where its tune starts being played
   *  at another pitch (the same tune again straight away in another key). Lambda
   *  is the price of a change of pitch, in the unit of a window's score;
   *  tolerance, in semitones, how far a pitch may sit from another and still be
   *  the same (a quarter tone). Measured and swept in pitchSplit.ts's header.
   *  Undefined lambda = no split (the engine before). */
  pitchSplitLambda?: number;
  pitchSplitTolerance?: number;
}

/** The thresholds of the engine the app runs: pitch classes, whatever the key
 *  (see ffWorker.ts). */
export const DETECTION_TEMPORAL_CONFIG: DetectionTemporalConfig = {
  stepSeconds: 5,
  windowSeconds: 10,

  // 2026-11-07, pitch-class recognition (see ffWorker.ts):
  // its scores run higher, noise included, so every absolute score threshold
  // below moved to the value equally RARE on the new scale (quantile matching of
  // all top-10 scores of the 17 annotated sessions, no annotation used):
  // 0.20 -> 0.35, 0.30 -> 0.42, 0.50 -> 0.61. The floor was ALSO chosen
  // independently by two-fold cross-validation (one half picks, the other is
  // scored): 0.35 and 0.40, flat between 0.30 and 0.40 — the translated 0.344
  // lands on it. Previous engine: 0.20 / 0.20 / 0.50 / 0.30.
  minCandidateProbability: 0.35,
  epsilon: 0.000001,
  unknownObservationProbability: 0.35,
  absentObservationRatio: 0.8,   // optimum 2026-09-13 — see the field's doc (threshold law: < e^−0.2)

  // Transition costs, 2026-11-07: the previous engine's (1.0 / 0.2 / 0.5 / 0.5)
  // x 0.65. They are in the same unit as the evidence a window brings,
  // log(score / floor), and that evidence shrank on the pitch-class scale
  // (median 0.98 -> 0.71 over every top-1 above the floor; 1.20 -> 0.93 against
  // the absence floor): left as they were, changing tune needed ~30 % more
  // evidence than before, and inside a set the new tune was named within 10 s
  // half as often as with the previous engine (19 % vs 40 %), the previous
  // name lingering meanwhile. 0.65 is where two-fold cross-validation landed,
  // at the edge of that 0.68-0.78 translation; with tailClearLead below it
  // keeps the same tunes and false positives. THRESHOLD LAW of
  // absentObservationRatio still holds: 0.8 < e^-0.13 = 0.878.
  // rapidChangePenalty measured without any effect from 0 to 10, kept as is.
  sameTuneTransitionCost: 0,
  tuneChangePenalty: 0.65,

  unknownStayPenalty: 0.13,
  tuneToUnknownPenalty: 0.325,
  unknownToTunePenalty: 0.325,

  rapidChangePenalty: 2.0,

  bucketHighConfidence: 0.61,
  bucketMediumConfidence: 0.42,
  maxAlternates: 4,

  minSegmentWindows: 2,
  tailClearLead: 0.06,
  tailClearLeadOverThird: 0.15,
  sameTuneMergeGapWindows: 10,

  flatWindowTopN: 3,
  flatWindowMarginThreshold: 0.05,

  // Off (2026-11-08) — see the field's doc.
  tempoSpreadThreshold: 0,

  // 2026-11-08 — see pitchSplit.ts: plateau 0.5-0.6, the side away from wrong cuts.
  pitchSplitLambda: 0.6,
  pitchSplitTolerance: 0.5,
};
