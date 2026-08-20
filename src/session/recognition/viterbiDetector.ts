import type { DetectionTemporalConfig } from './detectionTemporalConfig';
import { UNKNOWN_STATE, type TemporalTimeline } from './temporalObservationBuilder';

// ── Viterbi detector ────────────────────────────────────────────────────────
// TemporalTimeline -> DetectedTuneSegment[]. Global dynamic-programming
// decode over the WHOLE recording at once (not a per-window or per-pair local
// decision, unlike the pre-2026-08 hysteresis-based segmenter this replaced)
// — see the 2026-08-13 spec for the full rationale. States = every tuneId in
// the timeline's
// (already-filtered) candidate set, plus one UNKNOWN state for silence/talk/
// noise/anything not confidently a tune. Fixed, hand-set transition costs for
// this V1 (no learned transition matrix yet — see DetectionTemporalConfig's
// doc for what a V2/V3 would add).
//
// runViterbiDetection() is O(T×S) — see the 2026-08-14 factorization proof
// (module-level comment above runViterbiDetectionOptimized below) for why
// this is exact, not an approximation. runViterbiDetectionReference() is the
// original O(T×S²) exhaustive-scan implementation, kept only as the
// equivalence-test oracle — see viterbiDetectorEquivalence.test.ts.

export interface DetectedTuneSegment {
  /** UNKNOWN_STATE for a silence/talk/noise segment. */
  tuneId: string;
  displayName: string;
  settingId: string;
  dance: string;
  meter: string;
  /** The time range COVERED BY THE OBSERVATION WINDOWS that produced this
   *  segment — i.e. `windows[firstWindowIndex].tWindowStart` through
   *  `windows[lastWindowIndex].tWindowEnd` (see windowRangeToTime's doc for
   *  the full rationale). This is NOT a claim that the tune actually started
   *  or stopped playing at exactly `startTime`/`endTime` — the detector has
   *  no way to know the real musical boundary any more precisely than "some
   *  time within the window(s) that changed the decision." Because analysis
   *  windows overlap each other by (windowSeconds − stepSeconds), two
   *  adjacent segments (e.g. a tune ending, then the next one starting)
   *  routinely OVERLAP by up to that same amount — this is expected and must
   *  be preserved, not trimmed into a disjoint partition. */
  startTime: number;
  endTime: number;
  /** Index into TemporalTimeline.windows of this segment's first window —
   *  the exact, unambiguous way to map back to per-window data (e.g.
   *  TemporalTimeline.ranks) for this segment's range, rather than
   *  re-deriving membership from a time-range comparison against
   *  startTime/endTime (fragile now that those can overlap — see above). */
  firstWindowIndex: number;
  /** V1: identical to averageProbability — kept as its own field because the
   *  two are expected to diverge later (e.g. once segment length or Viterbi
   *  margin factors in), not because there's a different formula yet. Always
   *  0 for an UNKNOWN segment (no tune probability applies). */
  confidence: number;
  averageProbability: number;
  minimumProbability: number;
  maximumProbability: number;
  windowCount: number;
}

export interface StepDebugEntry {
  state: string;
  observation: number;
  observationScore: number;
  bestPrevious: string | null;
  transitionCost: number;
  totalScore: number;
}

export interface ViterbiDebug {
  /** One row per window, one entry per candidate state that window. */
  steps: StepDebugEntry[][];
  /** The winning path after backtracking, one row per window. */
  selectedPath: { t: number; time: number; state: string; probability: number; cumulativeScore: number }[];
}

export interface ViterbiResult {
  segments: DetectedTuneSegment[];
  stats: { numberOfTransitions: number; numberOfWindows: number };
  /** The latest window index t such that EVERY window in [0, t] is
   *  GUARANTEED to keep its currently-decoded state no matter what future
   *  windows arrive — see findConvergencePoint's doc. -1 if nothing has
   *  converged yet. */
  convergedThroughIndex: number;
  debug?: ViterbiDebug;
}

function observationScore(p: number, cfg: DetectionTemporalConfig): number {
  return cfg.observationScoreFn
    ? cfg.observationScoreFn(p, cfg.epsilon)
    : Math.log(Math.max(p, cfg.epsilon));
}

/** Window index range -> a [start, end) time range.
 *
 *  IMPORTANT (2026-08-15, corrects an earlier "fix" from the same day that
 *  went the wrong way): this is the raw span of the OBSERVATION WINDOWS that
 *  produced this state run — `windows[firstIdx].tWindowStart` to
 *  `windows[lastIdx].tWindowEnd` — NOT a disjoint partition of the timeline.
 *  Analysis windows are `windowSeconds` (15s) wide, taken every `stepSeconds`
 *  (5s), so consecutive windows overlap by 10s; a state change between window
 *  i and window i+1 therefore produces two segments that legitimately overlap
 *  by up to that same 10s (e.g. tune A ending at window i's tWindowEnd while
 *  tune B's segment already starts at window i+1's tWindowStart, ~10s
 *  earlier). That overlap is NOT a bug and must not be trimmed away: it's an
 *  honest representation of "the observations backing this detection cover
 *  this time range" — not a claim that the tune actually started/ended at
 *  that exact instant, which the detector has no way to know with a
 *  resolution finer than one window. See DetectedTuneSegment's doc for the
 *  full semantics, and viterbiDetector.test.ts's "overlap is preserved..."
 *  suite for the regression test guarding this. Do not reintroduce a
 *  "next window's start" or "index × stepSeconds" formula here — both were
 *  tried and reverted specifically because they force segments apart. */
function windowRangeToTime(
  firstIdx: number,
  lastIdx: number,
  timeline: TemporalTimeline,
): { start: number; end: number } {
  const start = timeline.windows[firstIdx]!.tWindowStart;
  const end = timeline.windows[lastIdx]!.tWindowEnd;
  return { start, end };
}

function extractSegments(
  path: string[],
  timeline: TemporalTimeline,
): DetectedTuneSegment[] {
  const segments: DetectedTuneSegment[] = [];
  let runStart = 0;
  for (let t = 1; t <= path.length; t++) {
    if (t < path.length && path[t] === path[runStart]) continue;

    const state = path[runStart]!;
    const lastIdx = t - 1;
    const { start, end } = windowRangeToTime(runStart, lastIdx, timeline);

    const probs: number[] = [];
    for (let i = runStart; i <= lastIdx; i++) {
      probs.push(state === UNKNOWN_STATE ? 0 : timeline.observations.get(state)![i]!);
    }
    const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
    const meta = state === UNKNOWN_STATE ? null : timeline.meta.get(state)!;

    segments.push({
      tuneId: state,
      displayName: meta?.displayName ?? 'UNKNOWN',
      settingId: meta?.settingId ?? '',
      dance: meta?.dance ?? '',
      meter: meta?.meter ?? '',
      startTime: start,
      endTime: end,
      firstWindowIndex: runStart,
      confidence: avg,
      averageProbability: avg,
      minimumProbability: Math.min(...probs),
      maximumProbability: Math.max(...probs),
      windowCount: probs.length,
    });
    runStart = t;
  }
  return segments;
}

const UNKNOWN_PROBABILITY_FIELDS = { confidence: 0, averageProbability: 0, minimumProbability: 0, maximumProbability: 0 };

function asUnknown(s: DetectedTuneSegment): DetectedTuneSegment {
  return {
    ...s,
    tuneId: UNKNOWN_STATE,
    displayName: 'UNKNOWN',
    settingId: '',
    dance: '',
    meter: '',
    ...UNKNOWN_PROBABILITY_FIELDS,
  };
}

/** How many windows in [firstIdx, firstIdx+windowCount) had `tuneId` as their
 *  own #1-ranked raw candidate (TemporalTimeline.ranks, 1-based, set by
 *  buildTemporalTimeline straight off each window's own sorted candidate
 *  list — untouched by Viterbi). 2026-08-15: deliberately NOT the same thing
 *  as `windowCount` (how many windows Viterbi's global optimization
 *  ASSIGNED to this tuneId, which can include windows where the tune only
 *  won by hysteresis/transition cost, never having been the top raw guess
 *  there) — the user specifically wants confirmation tied to the engine's
 *  own top pick, a stricter and more stable signal. */
export function countTop1Windows(tuneId: string, firstIdx: number, windowCount: number, timeline: TemporalTimeline): number {
  const ranks = timeline.ranks.get(tuneId);
  if (!ranks) return 0;
  let count = 0;
  for (let i = firstIdx; i < firstIdx + windowCount; i++) {
    if (ranks[i] === 1) count++;
  }
  return count;
}

/** Post-process, deliberately kept OUTSIDE the Viterbi decode itself (see
 *  minSegmentWindows's doc in detectionTemporalConfig.ts): a segment is only
 *  as trustworthy as how many of its OWN windows had it as the #1 raw
 *  candidate (see countTop1Windows) — fewer than `minWindowCount` such
 *  windows and the whole segment is relabeled UNKNOWN (the Viterbi
 *  path/scores/timestamps are NOT touched — only how this one segment is
 *  reported), then adjacent UNKNOWN segments are merged into one so the
 *  result never has two UNKNOWN segments sitting back to back.
 *
 *  `exemptLastSegment`: while detection is still in progress (live capture or
 *  an import/recording still streaming windows in), the very last segment IS
 *  shown even if still short — the user explicitly wants this (2026-08-15:
 *  "si c'est la dernière fenêtre alors j'accepte de l'afficher, c'est juste
 *  qu'il va ensuite disparaître"). A single-window guess can therefore still
 *  get opened as a real annotation and then be superseded a few seconds
 *  later — see viterbiSegmenter.ts's vanish-cleanup for how that close is
 *  marked NOT finalized (not confirmed, but not hidden either) rather than
 *  pretending it was never shown. Once truly finalized (no more windows will
 *  ever arrive), pass `false`: a genuinely short last segment is filtered
 *  exactly like any other. */
export function filterShortSegments(
  segments: DetectedTuneSegment[],
  timeline: TemporalTimeline,
  minWindowCount: number,
  exemptLastSegment: boolean,
): DetectedTuneSegment[] {
  const lastIdx = segments.length - 1;
  const relabeled = segments.map((s, i) => {
    if (s.tuneId === UNKNOWN_STATE) return s;
    if (exemptLastSegment && i === lastIdx) return s;
    if (countTop1Windows(s.tuneId, s.firstWindowIndex, s.windowCount, timeline) >= minWindowCount) return s;
    return asUnknown(s);
  });

  const merged: DetectedTuneSegment[] = [];
  for (const s of relabeled) {
    const prev = merged[merged.length - 1];
    if (prev && prev.tuneId === UNKNOWN_STATE && s.tuneId === UNKNOWN_STATE) {
      merged[merged.length - 1] = {
        ...prev,
        endTime: s.endTime,
        windowCount: prev.windowCount + s.windowCount,
        ...UNKNOWN_PROBABILITY_FIELDS, // both sides are already all-zero; stays exact
      };
      continue;
    }
    merged.push(s);
  }
  return merged;
}

/** Index in `segments` of the most recent NON-UNKNOWN entry, or -1. Only
 *  ever needs to look at the last one or two entries: filterShortSegments
 *  already guarantees no two UNKNOWN segments sit adjacent, and this
 *  function's own merges never introduce a new UNKNOWN-UNKNOWN adjacency
 *  either (it only ever combines two REAL segments) — so at most one
 *  trailing UNKNOWN can separate `segments`'s last entry from the last real
 *  one. */
function lastRealIndex(segments: DetectedTuneSegment[]): number {
  const last = segments.length - 1;
  if (last < 0) return -1;
  if (segments[last]!.tuneId !== UNKNOWN_STATE) return last;
  if (last > 0 && segments[last - 1]!.tuneId !== UNKNOWN_STATE) return last - 1;
  return -1;
}

function mergeTwoSameTune(a: DetectedTuneSegment, b: DetectedTuneSegment, timeline: TemporalTimeline): DetectedTuneSegment {
  const firstWindowIndex = a.firstWindowIndex;
  const windowCount = (b.firstWindowIndex + b.windowCount) - a.firstWindowIndex;
  const obs = timeline.observations.get(a.tuneId);
  const probs: number[] = [];
  for (let i = firstWindowIndex; i < firstWindowIndex + windowCount; i++) probs.push(obs?.[i] ?? 0);
  const avg = probs.reduce((x, y) => x + y, 0) / probs.length;
  return {
    ...a,
    endTime: b.endTime,
    firstWindowIndex,
    windowCount,
    confidence: avg,
    averageProbability: avg,
    minimumProbability: Math.min(...probs),
    maximumProbability: Math.max(...probs),
  };
}

/** Post-process (2026-08-15), run AFTER filterShortSegments: two "tune
 *  results" (i.e. real, non-UNKNOWN segments — deliberately blind to
 *  whatever UNKNOWN stretch separates them, since that's exactly the case
 *  this exists to bridge) for the SAME tuneId, with fewer than
 *  `maxGapWindows` windows between the first's end and the second's start,
 *  are merged into one continuous segment — a brief drop to UNKNOWN (a
 *  couple of quiet/noisy windows mid-tune) shouldn't split one real
 *  performance into two separate results. Explicit user request: "si 2 tune
 *  results consécutifs sont la même tune, que ça fusionne automatiquement
 *  s'il y a moins de N fenêtres d'écart."
 *
 *  Deliberately does NOT fire across a DIFFERENT real tune in between (A,
 *  B, A): by construction, if a different tune's segment sits between two
 *  A's, the A's are no longer "consecutive tune results" to each other — B
 *  is the one adjacent to each of them — so nothing here ever merges across
 *  or silently absorbs a separately-confirmed different tune.
 *
 *  Probability stats (confidence/average/min/max) are recomputed over the
 *  WHOLE bridged window range (gap windows included, using the same
 *  zero-if-absent TemporalTimeline.observations extractSegments itself
 *  reads) — not a weighted average of the two original segments' stats —
 *  so a merged segment's numbers mean the same thing as any other
 *  segment's: "the tune's own observed scores across its actual window
 *  range," gap included. */
export function mergeNearbySameTune(
  segments: DetectedTuneSegment[],
  timeline: TemporalTimeline,
  maxGapWindows: number,
): DetectedTuneSegment[] {
  const result: DetectedTuneSegment[] = [];
  for (const s of segments) {
    if (s.tuneId !== UNKNOWN_STATE) {
      const idx = lastRealIndex(result);
      if (idx >= 0) {
        const prevReal = result[idx]!;
        const gap = s.firstWindowIndex - (prevReal.firstWindowIndex + prevReal.windowCount);
        if (prevReal.tuneId === s.tuneId && gap < maxGapWindows) {
          result.length = idx; // drop prevReal and any UNKNOWN entry after it — both absorbed into the merge
          result.push(mergeTwoSameTune(prevReal, s, timeline));
          continue;
        }
      }
    }
    result.push(s);
  }
  return result;
}

/** The latest window index t* such that EVERY current per-state optimal
 *  backtrack path — not just the single overall winner finalize() below
 *  backtracks — agrees on the decoded state for every window in [0, t*].
 *  This is an exact property of Viterbi decoding ("path convergence" /
 *  "traceback merge point" in the streaming-decoder literature): a global
 *  decode's optimal path for the whole recording always originates from one
 *  of the CURRENT best-score-per-state chains, so once all of them agree on
 *  a shared prefix, no future window — however it scores — can ever change
 *  the decode for that prefix again. Runs one backward pass tracking each
 *  state's own backtrack pointer simultaneously (O(T×S), same class already
 *  benchmarked as cheap for the per-step live recompute) — the first time
 *  all pointers coincide is the answer; they can only ever stay merged once
 *  they meet, never diverge again, since from then on every state's pointer
 *  is tracing the exact same underlying chain.
 *
 *  Replaces the old finalizationLagSeconds heuristic (2026-08-15: an
 *  EMPIRICAL probe across 4 real sessions that never saw a revision reach
 *  more than 0 windows back) — that heuristic turned out not to be a real
 *  guarantee: a 2026-08-21 bug report (two separate "Rolling Waves, The"
 *  results from one performance) traced back to exactly a revision the probe
 *  never covered, reaching much further back than 0 windows once the whole
 *  session's context was available. This function answers the question
 *  exactly instead of by precedent. -1 if nothing has converged yet — a
 *  short or genuinely ambiguous recording may legitimately have no final
 *  answer yet; that's a correct "don't know", never a wrong "final". */
function findConvergencePoint(T: number, states: string[], previousState: Map<string, string | null>[]): number {
  if (T === 0) return -1;
  if (states.length <= 1) return T - 1; // only one possible state ever — trivially converged
  let pointer = new Map<string, string>(states.map(s => [s, s])); // each state's own backtrack pointer, currently at time T-1
  for (let t = T - 1; t >= 1; t--) {
    const next = new Map<string, string>();
    for (const s of states) next.set(s, previousState[t]!.get(pointer.get(s)!)!);
    pointer = next;
    if (new Set(pointer.values()).size === 1) return t - 1;
  }
  return -1;
}

/** Shared by both implementations: turns a completed (score, prevState) DP
 *  table into the final ViterbiResult (backtrack + segment extraction +
 *  optional debug payload). */
function finalize(
  T: number,
  states: string[],
  bestScore: Map<string, number>[],
  previousState: Map<string, string | null>[],
  debugSteps: StepDebugEntry[][],
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  debug: boolean,
): ViterbiResult {
  let bestFinal: string | null = null;
  let bestFinalScore = -Infinity;
  for (const s of states) {
    const sc = bestScore[T - 1]!.get(s)!;
    if (sc > bestFinalScore) { bestFinalScore = sc; bestFinal = s; }
  }

  const path: string[] = new Array(T);
  path[T - 1] = bestFinal!;
  for (let t = T - 1; t > 0; t--) {
    path[t - 1] = previousState[t]!.get(path[t]!)!;
  }

  const segments = extractSegments(path, timeline);
  const result: ViterbiResult = {
    segments,
    stats: {
      numberOfTransitions: segments.length > 0 ? segments.length - 1 : 0,
      numberOfWindows: T,
    },
    convergedThroughIndex: findConvergencePoint(T, states, previousState),
  };

  if (debug) {
    result.debug = {
      steps: debugSteps,
      selectedPath: path.map((state, t) => ({
        t,
        time: timeline.windows[t]!.tWindowStart,
        state,
        probability: state === UNKNOWN_STATE ? cfg.unknownObservationProbability : timeline.observations.get(state)![t]!,
        cumulativeScore: bestScore[t]!.get(state)!,
      })),
    };
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// REFERENCE implementation — O(T×S²), exhaustive scan. Kept ONLY as the
// equivalence-test oracle for the optimized version below (see
// viterbiDetectorEquivalence.test.ts) — not meant for production use once
// the optimized version is validated.
// ═══════════════════════════════════════════════════════════════════════════

/** Returns a positive cost (subtracted from the running score, never added). */
function transitionCostReference(prev: string, curr: string, prevPrev: string | null, cfg: DetectionTemporalConfig): number {
  if (prev === curr) {
    return prev === UNKNOWN_STATE ? cfg.unknownStayPenalty : cfg.sameTuneTransitionCost;
  }
  if (prev === UNKNOWN_STATE) return cfg.unknownToTunePenalty;
  if (curr === UNKNOWN_STATE) return cfg.tuneToUnknownPenalty;
  const bounceBack = prevPrev === curr;
  return cfg.tuneChangePenalty + (bounceBack ? cfg.rapidChangePenalty : 0);
}

export function runViterbiDetectionReference(
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  options: { debug?: boolean } = {},
): ViterbiResult {
  const T = timeline.windows.length;
  if (T === 0) return { segments: [], stats: { numberOfTransitions: 0, numberOfWindows: 0 }, convergedThroughIndex: -1 };

  const states = [...timeline.tuneIds, UNKNOWN_STATE];

  const bestScore: Map<string, number>[] = [];
  const previousState: Map<string, string | null>[] = [];
  const debugSteps: StepDebugEntry[][] = [];

  for (let t = 0; t < T; t++) {
    const scoreRow = new Map<string, number>();
    const prevRow = new Map<string, string | null>();
    const debugRow: StepDebugEntry[] = [];

    for (const s of states) {
      const p = s === UNKNOWN_STATE ? cfg.unknownObservationProbability : timeline.observations.get(s)![t]!;
      const obsScore = observationScore(p, cfg);

      if (t === 0) {
        scoreRow.set(s, obsScore);
        prevRow.set(s, null);
        debugRow.push({ state: s, observation: p, observationScore: obsScore, bestPrevious: null, transitionCost: 0, totalScore: obsScore });
        continue;
      }

      let best = -Infinity;
      let bestFrom: string | null = null;
      let bestCost = 0;
      for (const prev of states) {
        const prevScore = bestScore[t - 1]!.get(prev)!;
        const prevPrev = previousState[t - 1]!.get(prev) ?? null;
        const cost = transitionCostReference(prev, s, prevPrev, cfg);
        const candidate = prevScore - cost;
        if (candidate > best) { best = candidate; bestFrom = prev; bestCost = cost; }
      }
      const total = obsScore + best;
      scoreRow.set(s, total);
      prevRow.set(s, bestFrom);
      debugRow.push({ state: s, observation: p, observationScore: obsScore, bestPrevious: bestFrom, transitionCost: bestCost, totalScore: total });
    }

    bestScore.push(scoreRow);
    previousState.push(prevRow);
    if (options.debug) debugSteps.push(debugRow);
  }

  return finalize(T, states, bestScore, previousState, debugSteps, timeline, cfg, !!options.debug);
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIMIZED implementation — O(T×S). See the 2026-08-14 factorization proof
// (conversation record) for the correctness argument summarized here:
//
// For a fixed target state s, all S possible predecessors partition into 4
// disjoint categories, each with a CONSTANT cost within the category:
//   same        (p == s)
//   fromUnknown (p == UNKNOWN)
//   unpen       (p a different tune, its own predecessor ≠ s)
//   pen         (p a different tune, its own predecessor == s — the rebound case)
// Maximizing (score[p] - cost) within a constant-cost category reduces to
// maximizing score[p] alone. `unpen`/`pen` are found via, respectively, the
// global top-2 score (with a PROVABLY bounded — at most a couple of states
// per timestep — exact fallback scan when both top-2 entries are
// disqualified for this specific s) and a per-"predecessor's-own-predecessor"
// grouping (top-2 within each group, built in one O(S) pass). Every lookup
// resolves ties by the same canonical state order the reference scan uses,
// so the two implementations are provably path-identical, not just
// score-identical — verified empirically in viterbiDetectorEquivalence.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

interface ScoreEntry { state: string; score: number }

/** Top-2 by score among a sequence, ties keeping whichever was seen FIRST —
 *  replicates the reference's "scan in canonical order, strict >" semantics
 *  as long as the caller iterates in canonical order (tuneIds is already in
 *  that order; this file never reorders it). */
function updateTop2(top1: ScoreEntry | null, top2: ScoreEntry | null, entry: ScoreEntry): [ScoreEntry | null, ScoreEntry | null] {
  if (top1 === null || entry.score > top1.score) return [entry, top1];
  if (top2 === null || entry.score > top2.score) return [top1, entry];
  return [top1, top2];
}

interface PrevRowIndex {
  prevState: Map<string, string | null>;
  /** Global top-2 among TUNE states (excludes UNKNOWN), ranked by the
   *  ALREADY-cost-adjusted "unpen" value (score − tuneChangePenalty) — not
   *  the raw score. This matters: subtracting the same constant from two
   *  nearly-equal floats can round two DISTINGUISHABLE raw scores down to
   *  the exact same float64 (a real case hit while testing — see
   *  viterbiDetectorEquivalence.test.ts). Ranking on the raw score and
   *  subtracting the constant later can therefore pick a different winner
   *  than the reference implementation, which always compares
   *  already-subtracted values. Ranking on the pre-adjusted value instead
   *  reproduces the reference's rounding behaviour exactly, not just its
   *  real-number behaviour. */
  top1: ScoreEntry | null;
  top2: ScoreEntry | null;
  /** Per-tag (= state's own predecessor) top-2, ranked by the "pen" value
   *  (score − tuneChangePenalty − rapidChangePenalty) for the same reason. */
  groupTop: Map<string, [ScoreEntry, ScoreEntry | null]>;
  /** Best tune under a THIRD, INDEPENDENT adjustment (score − tuneToUnknownPenalty)
   *  — used only for "any tune -> UNKNOWN". Must NOT reuse `top1` (adjusted by
   *  the different constant tuneChangePenalty): a rounding collision at one
   *  constant doesn't imply one at another, so each adjustment needs its own
   *  ranking pass. No "excluding s" complexity needed here — UNKNOWN can never
   *  equal a tune state, so a single top-1 (no top-2 fallback) suffices. */
  bestToUnknown: ScoreEntry | null;
}

function indexPrevRow(
  tuneIds: string[],
  score: Map<string, number>,
  prevState: Map<string, string | null>,
  cfg: DetectionTemporalConfig,
): PrevRowIndex {
  let top1: ScoreEntry | null = null;
  let top2: ScoreEntry | null = null;
  let bestToUnknown: ScoreEntry | null = null;
  const groupTop = new Map<string, [ScoreEntry, ScoreEntry | null]>();

  for (const p of tuneIds) {
    const raw = score.get(p)!;
    const unpenValue = raw - cfg.tuneChangePenalty;
    [top1, top2] = updateTop2(top1, top2, { state: p, score: unpenValue });

    const toUnknownValue = raw - cfg.tuneToUnknownPenalty;
    if (bestToUnknown === null || toUnknownValue > bestToUnknown.score) bestToUnknown = { state: p, score: toUnknownValue };

    const tag = prevState.get(p) ?? null;
    if (tag === null) continue; // t==1: no predecessor history yet, contributes to no group
    const penValue = raw - cfg.tuneChangePenalty - cfg.rapidChangePenalty;
    const existing = groupTop.get(tag);
    if (!existing) { groupTop.set(tag, [{ state: p, score: penValue }, null]); continue; }
    const [g1, g2] = existing;
    if (penValue > g1.score) groupTop.set(tag, [{ state: p, score: penValue }, g1]);
    else if (g2 === null || penValue > g2.score) groupTop.set(tag, [g1, { state: p, score: penValue }]);
  }

  return { prevState, top1, top2, groupTop, bestToUnknown };
}

/** Best tune p ≠ cur with p's own predecessor ≠ cur (the "unpen" category).
 *  Returns the FINAL adjusted (score − tuneChangePenalty) value, ready to use
 *  directly as a candidate value — see indexPrevRow's doc for why ranking and
 *  adjusting must happen in this order. Fast path O(1) for all but a bounded
 *  handful of `cur` per timestep — see the module-level proof for why the
 *  fallback is provably rare, not just usually rare. The fallback itself is
 *  an exact, unconditionally-correct scan, so correctness never depends on
 *  the bound being tight. */
function bestUnpenalizedExcluding(cur: string, idx: PrevRowIndex, tuneIds: string[], score: Map<string, number>, cfg: DetectionTemporalConfig): ScoreEntry | null {
  for (const cand of [idx.top1, idx.top2]) {
    if (cand && cand.state !== cur && (idx.prevState.get(cand.state) ?? null) !== cur) return cand;
  }
  let best: ScoreEntry | null = null;
  for (const p of tuneIds) {
    if (p === cur) continue;
    if ((idx.prevState.get(p) ?? null) === cur) continue;
    const v = score.get(p)! - cfg.tuneChangePenalty;
    if (best === null || v > best.score) best = { state: p, score: v };
  }
  return best;
}

/** Best tune p ≠ cur with p's own predecessor == cur (the "pen" / rebound
 *  category). Returns the FINAL adjusted value, same reasoning as above. */
function bestPenalizedFor(cur: string, idx: PrevRowIndex): ScoreEntry | null {
  const group = idx.groupTop.get(cur);
  if (!group) return null;
  for (const cand of group) {
    if (cand && cand.state !== cur) return cand;
  }
  return null;
}

interface Candidate { state: string; cost: number; value: number }

/** Picks the candidate with the highest value; ties broken by canonical
 *  state order (stateIndex), replicating the reference's linear-scan
 *  first-found-wins-ties semantics exactly. */
function pickBest(candidates: Candidate[], stateIndex: Map<string, number>): Candidate {
  let best = candidates[0]!;
  let bestIdx = stateIndex.get(best.state)!;
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!;
    const cIdx = stateIndex.get(c.state)!;
    if (c.value > best.value || (c.value === best.value && cIdx < bestIdx)) { best = c; bestIdx = cIdx; }
  }
  return best;
}

export function runViterbiDetectionOptimized(
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  options: { debug?: boolean } = {},
): ViterbiResult {
  const T = timeline.windows.length;
  if (T === 0) return { segments: [], stats: { numberOfTransitions: 0, numberOfWindows: 0 }, convergedThroughIndex: -1 };

  const tuneIds = timeline.tuneIds;
  const states = [...tuneIds, UNKNOWN_STATE];
  const stateIndex = new Map<string, number>(states.map((s, i) => [s, i]));

  const bestScore: Map<string, number>[] = [];
  const previousState: Map<string, string | null>[] = [];
  const debugSteps: StepDebugEntry[][] = [];

  for (let t = 0; t < T; t++) {
    const scoreRow = new Map<string, number>();
    const prevRow = new Map<string, string | null>();
    const debugRow: StepDebugEntry[] = [];
    const pushEntry = (state: string, p: number, obsScore: number, bestPrevious: string | null, cost: number, total: number) => {
      scoreRow.set(state, total);
      prevRow.set(state, bestPrevious);
      if (options.debug) debugRow.push({ state, observation: p, observationScore: obsScore, bestPrevious, transitionCost: cost, totalScore: total });
    };

    if (t === 0) {
      for (const s of states) {
        const p = s === UNKNOWN_STATE ? cfg.unknownObservationProbability : timeline.observations.get(s)![t]!;
        const obsScore = observationScore(p, cfg);
        pushEntry(s, p, obsScore, null, 0, obsScore);
      }
      bestScore.push(scoreRow);
      previousState.push(prevRow);
      if (options.debug) debugSteps.push(debugRow);
      continue;
    }

    const idx = indexPrevRow(tuneIds, bestScore[t - 1]!, previousState[t - 1]!, cfg);
    const unknownScorePrev = bestScore[t - 1]!.get(UNKNOWN_STATE)!;

    for (const cur of tuneIds) {
      const candidates: Candidate[] = [
        { state: cur, cost: cfg.sameTuneTransitionCost, value: bestScore[t - 1]!.get(cur)! - cfg.sameTuneTransitionCost },
        { state: UNKNOWN_STATE, cost: cfg.unknownToTunePenalty, value: unknownScorePrev - cfg.unknownToTunePenalty },
      ];
      // unpen.score / pen.score already have their cost baked in (see
      // indexPrevRow's doc) — do NOT subtract cfg.tuneChangePenalty again here.
      const unpen = bestUnpenalizedExcluding(cur, idx, tuneIds, bestScore[t - 1]!, cfg);
      if (unpen) candidates.push({ state: unpen.state, cost: cfg.tuneChangePenalty, value: unpen.score });
      const pen = bestPenalizedFor(cur, idx);
      if (pen) candidates.push({ state: pen.state, cost: cfg.tuneChangePenalty + cfg.rapidChangePenalty, value: pen.score });

      const winner = pickBest(candidates, stateIndex);
      const p = timeline.observations.get(cur)![t]!;
      const obsScore = observationScore(p, cfg);
      pushEntry(cur, p, obsScore, winner.state, winner.cost, obsScore + winner.value);
    }

    // UNKNOWN as the current state: same (stay in UNKNOWN) vs the single
    // best tune -> UNKNOWN (no rebound consideration applies to this
    // direction, so idx.bestToUnknown alone is always correct here — its own
    // independent ranking, NOT idx.top1, which is adjusted by a different
    // constant and can disagree at a rounding boundary).
    {
      const candidates: Candidate[] = [
        { state: UNKNOWN_STATE, cost: cfg.unknownStayPenalty, value: unknownScorePrev - cfg.unknownStayPenalty },
      ];
      if (idx.bestToUnknown) candidates.push({ state: idx.bestToUnknown.state, cost: cfg.tuneToUnknownPenalty, value: idx.bestToUnknown.score });
      const winner = pickBest(candidates, stateIndex);
      const p = cfg.unknownObservationProbability;
      const obsScore = observationScore(p, cfg);
      pushEntry(UNKNOWN_STATE, p, obsScore, winner.state, winner.cost, obsScore + winner.value);
    }

    bestScore.push(scoreRow);
    previousState.push(prevRow);
    if (options.debug) debugSteps.push(debugRow);
  }

  return finalize(T, states, bestScore, previousState, debugSteps, timeline, cfg, !!options.debug);
}

export const runViterbiDetection = runViterbiDetectionOptimized;
