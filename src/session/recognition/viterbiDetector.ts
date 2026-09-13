import type { DetectionTemporalConfig } from './detectionTemporalConfig';
import { UNKNOWN_STATE, observationAt, rowStartAt, type TemporalTimeline } from './temporalObservationBuilder';

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
//
// StreamingViterbiDecoder (2026-08-23) is the incremental, stateful sibling
// used by viterbiSegmenter.ts's window-by-window feed: amortized O(T×S) over
// a whole session instead of paying runViterbiDetection()'s O(T×S) again
// from scratch on every single window (O(T²×S) summed). See its own header
// doc for the correctness argument and viterbiStreamingEquivalence.test.ts
// for the equivalence-test oracle that checks it holds at every step.

export interface DetectedTuneSegment {
  /** UNKNOWN_STATE for a silence/talk/noise segment. */
  tuneId: string;
  displayName: string;
  settingId: string;
  dance: string;
  meter: string;
  /** Best ESTIMATE of when the tune started and stopped, each boundary placed
   *  midway between the centres of the two windows that straddle it — see
   *  windowRangeToTime for why that is the right point and what it measured.
   *  Accurate to roughly half a hop either way (median 1.0s, 22 of 24 within
   *  +/-5s on the session timed tune by tune), which is as fine as the hop
   *  allows: the scores saturate, so nothing in them locates a boundary INSIDE
   *  a hop (measured — see the same doc's history).
   *
   *  Adjacent segments abut; they no longer overlap. Anything that needs slack
   *  around a segment (extracting a clip, say) must add its own margin. */
  startTime: number;
  endTime: number;
  /** Index into TemporalTimeline.windows of this segment's first window —
   *  the exact, unambiguous way to map back to per-window data (e.g.
   *  its row in TemporalTimeline.rows) for this segment's range. ALWAYS use this rather
   *  than re-deriving membership by comparing window timestamps against
   *  startTime/endTime: those are now estimated boundaries that sit INSIDE the
   *  first and last windows, so a time comparison silently drops them. */
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
 *  A window is matched against whichever tune occupies MOST of it, so when the
 *  decode flips between window k and window k+1, the real musical boundary lies
 *  between those two windows' CENTRES — and the midpoint of the two centres is
 *  the minimum-error estimate of it. An exterior edge (the first or last window
 *  of the recording) is not a transition at all: it is where the recording
 *  itself begins or ends, and stays there.
 *
 *  Reads the neighbours' real centres rather than assuming a fixed hop, so a
 *  timeline whose windows are unevenly spaced (a catch-up window, a final
 *  partial-hop window at stop) is handled correctly with no special case.
 *
 *  2026-09-01, REPLACES the raw window span (`windows[firstIdx].tWindowStart`
 *  to `windows[lastIdx].tWindowEnd`) that shipped from 2026-08-15. That version
 *  was chosen on semantic grounds — "the observations backing this detection
 *  cover this range" — and had never been measured against ground truth. It is
 *  early by exactly (windowSeconds - stepSeconds) / 2 : the model predicts
 *  -5.0s at hop 5 and 0.0s at hop 15 (where the two formulas coincide), and
 *  across the 196 detections of six annotated sessions the measured offsets are
 *  -5.0s and +0.0s. On the one session timed tune by tune, the median start
 *  error goes 5.0s -> 1.0s and the count within +/-5s goes 16/24 -> 22/24.
 *
 *  Consequence to know: adjacent segments now ABUT instead of overlapping by
 *  (windowSeconds - stepSeconds). 65 of 143 neighbouring result pairs used to
 *  overlap; none do now. Displayed durations shrink accordingly (median 105s ->
 *  95s), which is the honest number, not a regression — and anything that wants
 *  slack around a segment (clip extraction) adds its own margin rather than
 *  relying on this being wide. Segment membership is NEVER re-derived from
 *  these times: use `firstWindowIndex`/`windowCount`, which say exactly which
 *  windows a segment owns. */
function windowRangeToTime(
  firstIdx: number,
  lastIdx: number,
  timeline: TemporalTimeline,
): { start: number; end: number } {
  const w = timeline.windows;
  const centre = (i: number) => (w[i]!.tWindowStart + w[i]!.tWindowEnd) / 2;
  return {
    start: firstIdx === 0 ? w[0]!.tWindowStart : (centre(firstIdx - 1) + centre(firstIdx)) / 2,
    end: lastIdx === w.length - 1 ? w[lastIdx]!.tWindowEnd : (centre(lastIdx) + centre(lastIdx + 1)) / 2,
  };
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

    // One walk along the tune's sparse row rather than a lookup per window —
    // same array as before, 0 wherever the tune was not a candidate.
    const probs: number[] = new Array<number>(lastIdx - runStart + 1).fill(0);
    if (state !== UNKNOWN_STATE) {
      const row = timeline.rows.get(state)!;
      for (let k = rowStartAt(row, runStart); k < row.t.length && row.t[k]! <= lastIdx; k++) {
        probs[row.t[k]! - runStart] = row.score[k]!;
      }
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
 *  own #1-ranked raw candidate (the rank in TemporalTimeline.rows, 1-based, set by
 *  buildTemporalTimeline straight off each window's own sorted candidate
 *  list — untouched by Viterbi). 2026-08-15: deliberately NOT the same thing
 *  as `windowCount` (how many windows Viterbi's global optimization
 *  ASSIGNED to this tuneId, which can include windows where the tune only
 *  won by hysteresis/transition cost, never having been the top raw guess
 *  there) — the user specifically wants confirmation tied to the engine's
 *  own top pick, a stricter and more stable signal. */
export function countTop1Windows(tuneId: string, firstIdx: number, windowCount: number, timeline: TemporalTimeline): number {
  const row = timeline.rows.get(tuneId);
  if (!row) return 0;
  // Only a window the tune was a candidate in can have it at rank 1 — an absent
  // window read null in the dense form, never 1.
  const end = firstIdx + windowCount;
  let count = 0;
  for (let k = rowStartAt(row, firstIdx); k < row.t.length && row.t[k]! < end; k++) {
    if (row.rank[k] === 1) count++;
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
 *  get opened as a real detection and then be superseded a few seconds
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
  const probs: number[] = new Array<number>(Math.max(0, windowCount)).fill(0);
  const row = timeline.rows.get(a.tuneId);
  if (row) {
    const end = firstWindowIndex + windowCount;
    for (let k = rowStartAt(row, firstWindowIndex); k < row.t.length && row.t[k]! < end; k++) {
      probs[row.t[k]! - firstWindowIndex] = row.score[k]!;
    }
  }
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
 *  zero-if-absent TemporalTimeline row reading extractSegments itself
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


/** Shared by both from-scratch implementations AND the streaming decoder:
 *  turns a completed (score, prevState) DP table into the final ViterbiResult
 *  (backtrack + segment extraction + optional debug payload).
 *  `convergedThroughIndex` is passed in rather than recomputed here — the two
 *  from-scratch implementations pass `findConvergencePoint(...)` (unbounded,
 *  cheap enough for a one-shot full decode); the streaming decoder passes its
 *  own incrementally-maintained value (see advanceConvergence). */
function buildResult(
  T: number,
  states: string[],
  bestScore: Map<string, number>[],
  previousState: Map<string, string | null>[],
  debugSteps: StepDebugEntry[][],
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  convergedThroughIndex: number,
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
    convergedThroughIndex,
  };

  if (debug) {
    result.debug = {
      steps: debugSteps,
      selectedPath: path.map((state, t) => ({
        t,
        time: timeline.windows[t]!.tWindowStart,
        state,
        probability: state === UNKNOWN_STATE ? cfg.unknownObservationProbability : observationAt(timeline, state, t),
        cumulativeScore: bestScore[t]!.get(state)!,
      })),
    };
  }

  return result;
}

/** Thin wrapper kept for the two from-scratch implementations below: full
 *  unbounded convergence scan (findConvergencePoint), same as always. */
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
  return buildResult(T, states, bestScore, previousState, debugSteps, timeline, cfg, findConvergencePoint(T, states, previousState), debug);
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
      const p = s === UNKNOWN_STATE ? cfg.unknownObservationProbability : observationAt(timeline, s, t);
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

// ── Slots: the stable address of a state ─────────────────────────────────────
// The DP columns are typed arrays, so every state needs an integer address —
// and that address must never move, because the streaming decoder keeps
// columns from previous calls and a moved address would silently reinterpret
// all of them.
//
// `tuneIds` positions cannot serve: they are NOT stable (see the invariant
// correction in StreamingViterbiDecoder's header — a tune admitted late is
// inserted at its first-appearance position and shifts everything after it).
// So two notions, deliberately separate:
//
//   slot — handed out by the decoder the first time it sees a state, never
//          reused, never moved. Addresses the arrays. Append-only by
//          construction, so a column created earlier is simply SHORTER than
//          one created later; a state with no cell in an old column is one
//          that did not exist yet, which is exactly the `-Infinity` case the
//          correctness theorem in the streaming header already covers.
//   rank — position in `[...tuneIds, UNKNOWN]`, the canonical order. Used for
//          ONE thing: breaking ties exactly as the reference's linear scan
//          does. Recomputed whenever tuneIds changes; never addresses anything.
interface SlotSpace {
  slotOf: Map<string, number>;
  /** slot -> state name, for reporting results. */
  names: string[];
  /** slot -> canonical tie-break rank. */
  rank: Int32Array;
  /** canonical tune position -> slot, for iterating tunes in canonical order. */
  tuneSlots: Int32Array;
  unknownSlot: number;
}

/** Creates or extends the space to cover `tuneIds` + UNKNOWN, and refreshes
 *  the tie-break ranks. Slots already handed out keep their value. */
function syncSlotSpace(space: SlotSpace | null, tuneIds: string[]): SlotSpace {
  const s: SlotSpace = space ?? {
    slotOf: new Map(), names: [], rank: new Int32Array(0),
    tuneSlots: new Int32Array(0), unknownSlot: -1,
  };
  for (const id of tuneIds) {
    if (!s.slotOf.has(id)) { s.slotOf.set(id, s.names.length); s.names.push(id); }
  }
  if (s.unknownSlot === -1) {
    s.unknownSlot = s.names.length;
    s.slotOf.set(UNKNOWN_STATE, s.unknownSlot);
    s.names.push(UNKNOWN_STATE);
  }
  // Refreshed every time, not just on growth: tuneIds may have REORDERED
  // without changing size.
  if (s.rank.length !== s.names.length) s.rank = new Int32Array(s.names.length);
  if (s.tuneSlots.length !== tuneIds.length) s.tuneSlots = new Int32Array(tuneIds.length);
  for (let i = 0; i < tuneIds.length; i++) {
    const slot = s.slotOf.get(tuneIds[i]!)!;
    s.tuneSlots[i] = slot;
    s.rank[slot] = i;
  }
  s.rank[s.unknownSlot] = tuneIds.length;   // UNKNOWN is last in canonical order
  return s;
}

/** One column of the DP table. Indexed by SLOT; `prev` holds the predecessor's
 *  slot, or -1 for "none" (the t=0 column, and unreachable cells). A column is
 *  sized to the slot count at the moment it was computed, so an older column
 *  is shorter than a newer one — see the slot doc above. */
interface Column {
  score: Float64Array;
  prev: Int32Array;
  debugRow?: StepDebugEntry[];
}

/** Reads a possibly-too-short cached column: a slot beyond its end belongs to
 *  a state that did not exist when it was computed. */
function scoreAt(col: Float64Array, slot: number): number {
  return slot < col.length ? col[slot]! : -Infinity;
}
function prevAt(col: Int32Array, slot: number): number {
  return slot < col.length ? col[slot]! : -1;
}

/** Scratch buffers for one decode's per-column index, sized to the state set
 *  and reused for every column instead of reallocated.
 *
 *  Everything here used to be objects and a string-keyed Map rebuilt per
 *  window: a `{state, score}` per tune for the top-2 pass, another for the
 *  "to UNKNOWN" pass, and a `Map<string, [entry, entry]>` of per-tag groups
 *  with its own pair array — several million allocations per decode, plus S
 *  string hashes per window for the group Map alone. The values are identical;
 *  only where they live changed.
 *
 *  Indexed by STATE INDEX (a tune's index in tuneIds; UNKNOWN last), which is
 *  the same integer `stateIndex` hands out — so a tag is looked up once and
 *  then addressed arithmetically. `-1` means "no entry". */
interface IndexScratch {
  /** Column number a slot was last written on. A slot counts as filled only
   *  when it matches the current generation, which is what lets a column start
   *  clean without clearing anything.
   *
   *  Clearing WAS the first attempt (two `fill(-1)` per column) and it was
   *  measurably slower than the Map it replaced — of course: the Map only ever
   *  held the handful of distinct tags a column actually produced, while a fill
   *  touches all S slots whether used or not. Measured 2026-09-13: 424 → 524 ms
   *  on one session before this counter, back to 424 with it. */
  groupGen: Int32Array;
  gen: number;
  groupSlot1: Int32Array;
  groupValue1: Float64Array;
  groupSlot2: Int32Array;
  groupValue2: Float64Array;
  /** Where the two "best predecessor" lookups leave their value, so neither
   *  has to allocate a result. Separate fields, not one, because the "unpen"
   *  value is still in play when the "pen" lookup runs. */
  unpenValue: number;
  penValue: number;
  /** This window's non-floor observations, scattered into slot-addressed
   *  scratch by the same generation trick as the groups above: a slot whose
   *  generation does not match simply has the floor.
   *
   *  Why it is worth scattering them at all: 0,27% of (window, state) cells
   *  carry an observation, so the other 99,73% were calling `Math.log` on a
   *  zero and getting the same constant back — 23,4% of the decode by the
   *  2026-09-13 profile, once the Maps were gone. */
  obsGen: Int32Array;
  obsGenCounter: number;
  obsP: Float64Array;
  obsScore: Float64Array;
}

function makeIndexScratch(slotCount: number): IndexScratch {
  return {
    // Zero-filled, and the first column runs at generation 1 — so nothing reads
    // as filled before it is written.
    groupGen: new Int32Array(slotCount),
    gen: 0,
    groupSlot1: new Int32Array(slotCount),
    groupValue1: new Float64Array(slotCount),
    groupSlot2: new Int32Array(slotCount),
    groupValue2: new Float64Array(slotCount),
    unpenValue: 0,
    penValue: 0,
    obsGen: new Int32Array(slotCount),
    obsGenCounter: 0,
    obsP: new Float64Array(slotCount),
    obsScore: new Float64Array(slotCount),
  };
}

/** One window's non-floor observations, flattened as [slot, p, score, …].
 *
 *  Read straight off the window's own candidate list — about ten entries — and
 *  mapped to slots, instead of probing every admitted tune (thousands) for the
 *  few that are present. A candidate with no slot was never admitted, so it has
 *  no observation. A value of exactly 0 is left out: `observationScore(0)` IS
 *  the floor, so listing it would change nothing. A tune listed twice in one
 *  window is listed twice here, and the scatter in computeColumn lets the later
 *  entry win — the same rule its sparse row applies (see SparseRow).
 *
 *  One function for both decoders now: with sparse rows there is no dense row
 *  left to walk, and the candidate list is the cheapest source there is. It is
 *  also exactly the list the rows were built from, in every builder. */
function obsEntriesForWindow(space: SlotSpace, timeline: TemporalTimeline, t: number, cfg: DetectionTemporalConfig): number[] {
  const out: number[] = [];
  for (const c of timeline.windows[t]!.candidates) {
    const slot = space.slotOf.get(c.tuneId);
    if (slot === undefined || slot === space.unknownSlot) continue;
    const p = c.score;
    if (p !== 0) out.push(slot, p, observationScore(p, cfg));
  }
  return out;
}

interface PrevRowIndex {
  /** The previous column's backpointers, by slot. */
  prevSlot: Int32Array;
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
  top1Slot: number; top1Value: number;
  top2Slot: number; top2Value: number;
  /** Per-tag (= state's own predecessor) top-2, ranked by the "pen" value
   *  (score − tuneChangePenalty − rapidChangePenalty) for the same reason.
   *  Lives in the scratch arrays, addressed by the tag's state index. */
  scratch: IndexScratch;
  /** Best tune under a THIRD, INDEPENDENT adjustment (score − tuneToUnknownPenalty)
   *  — used only for "any tune -> UNKNOWN". Must NOT reuse `top1` (adjusted by
   *  the different constant tuneChangePenalty): a rounding collision at one
   *  constant doesn't imply one at another, so each adjustment needs its own
   *  ranking pass. No "excluding s" complexity needed here — UNKNOWN can never
   *  equal a tune state, so a single top-1 (no top-2 fallback) suffices. */
  bestToUnknownSlot: number; bestToUnknownValue: number;
}

function indexPrevRow(
  tuneSlots: Int32Array,
  score: Float64Array,
  prevSlot: Int32Array,
  cfg: DetectionTemporalConfig,
  scratch: IndexScratch,
): PrevRowIndex {
  let top1Slot = -1, top1Value = 0;
  let top2Slot = -1, top2Value = 0;
  let bestToUnknownSlot = -1, bestToUnknownValue = 0;

  const gen = ++scratch.gen;
  const { groupGen, groupSlot1, groupValue1, groupSlot2, groupValue2 } = scratch;

  // Ties keep whichever tune was seen FIRST, which is what the strict `>`
  // gives as long as this loop runs in canonical order — the tuneSlots array
  // is in that order by construction, and nothing here reorders it.
  for (let i = 0; i < tuneSlots.length; i++) {
    const slot = tuneSlots[i]!;
    const raw = scoreAt(score, slot);
    const unpenValue = raw - cfg.tuneChangePenalty;
    if (top1Slot === -1 || unpenValue > top1Value) { top2Slot = top1Slot; top2Value = top1Value; top1Slot = slot; top1Value = unpenValue; }
    else if (top2Slot === -1 || unpenValue > top2Value) { top2Slot = slot; top2Value = unpenValue; }

    const toUnknownValue = raw - cfg.tuneToUnknownPenalty;
    if (bestToUnknownSlot === -1 || toUnknownValue > bestToUnknownValue) { bestToUnknownSlot = slot; bestToUnknownValue = toUnknownValue; }

    // The tag is already a slot — no name, no lookup.
    const g = prevAt(prevSlot, slot);
    if (g === -1) continue; // t==1: no predecessor history yet, contributes to no group
    const penValue = raw - cfg.tuneChangePenalty - cfg.rapidChangePenalty;
    if (groupGen[g] !== gen) {
      // First tune to land on this tag in this column.
      groupGen[g] = gen;
      groupSlot1[g] = slot;
      groupValue1[g] = penValue;
      groupSlot2[g] = -1;
    } else if (penValue > groupValue1[g]!) {
      groupSlot2[g] = groupSlot1[g]!;
      groupValue2[g] = groupValue1[g]!;
      groupSlot1[g] = slot;
      groupValue1[g] = penValue;
    } else if (groupSlot2[g] === -1 || penValue > groupValue2[g]!) {
      groupSlot2[g] = slot;
      groupValue2[g] = penValue;
    }
  }

  return { prevSlot, top1Slot, top1Value, top2Slot, top2Value, scratch, bestToUnknownSlot, bestToUnknownValue };
}

/** Best tune p ≠ cur with p's own predecessor ≠ cur (the "unpen" category).
 *  Returns the FINAL adjusted (score − tuneChangePenalty) value, ready to use
 *  directly as a candidate value — see indexPrevRow's doc for why ranking and
 *  adjusting must happen in this order. Fast path O(1) for all but a bounded
 *  handful of `cur` per timestep — see the module-level proof for why the
 *  fallback is provably rare, not just usually rare. The fallback itself is
 *  an exact, unconditionally-correct scan, so correctness never depends on
 *  the bound being tight. */
function bestUnpenalizedExcluding(
  curSlot: number, idx: PrevRowIndex, tuneSlots: Int32Array, score: Float64Array, cfg: DetectionTemporalConfig,
): number {
  const { top1Slot, top2Slot, prevSlot } = idx;
  if (top1Slot !== -1 && top1Slot !== curSlot && prevAt(prevSlot, top1Slot) !== curSlot) {
    idx.scratch.unpenValue = idx.top1Value; return top1Slot;
  }
  if (top2Slot !== -1 && top2Slot !== curSlot && prevAt(prevSlot, top2Slot) !== curSlot) {
    idx.scratch.unpenValue = idx.top2Value; return top2Slot;
  }
  // The provably-rare exact fallback.
  let bestSlot = -1;
  let bestValue = 0;
  for (let i = 0; i < tuneSlots.length; i++) {
    const p = tuneSlots[i]!;
    if (p === curSlot) continue;
    if (prevAt(prevSlot, p) === curSlot) continue;
    const v = scoreAt(score, p) - cfg.tuneChangePenalty;
    if (bestSlot === -1 || v > bestValue) { bestSlot = p; bestValue = v; }
  }
  idx.scratch.unpenValue = bestValue;
  return bestSlot;
}

/** Best tune p ≠ cur with p's own predecessor == cur (the "pen" / rebound
 *  category). Returns its slot and leaves the FINAL adjusted value in
 *  `scratch.penValue`, same reasoning as above. The group arrays are addressed
 *  by the tag's slot, and here the tag IS cur. */
function bestPenalizedFor(curSlot: number, idx: PrevRowIndex): number {
  const { scratch } = idx;
  if (scratch.groupGen[curSlot] !== scratch.gen) return -1;  // no group this column
  const s1 = scratch.groupSlot1[curSlot]!;
  if (s1 === -1) return -1;
  // Same two-step as the array scan it replaces: take the group's best unless
  // that IS cur, in which case the runner-up, and give up if there is none.
  if (s1 !== curSlot) { scratch.penValue = scratch.groupValue1[curSlot]!; return s1; }
  const s2 = scratch.groupSlot2[curSlot]!;
  if (s2 === -1 || s2 === curSlot) return -1;
  scratch.penValue = scratch.groupValue2[curSlot]!;
  return s2;
}

/** Computes ONE column (window t) of the O(T×S) DP table from the previous
 *  column alone — the single piece of per-window logic shared by the
 *  from-scratch optimized decode below AND StreamingViterbiDecoder, so
 *  there is exactly one implementation of "how a column is filled" to keep
 *  correct (acceptance criterion #6). `prevScore`/`prevPrevSlot` are the
 *  PREVIOUS column's two arrays — `null` for t===0.
 *
 *  A previous column SHORTER than the current slot count needs no patching by
 *  the caller any more: `scoreAt`/`prevAt` answer -Infinity / -1 past its end,
 *  which is precisely the seeding the streaming decoder used to write by hand
 *  into the boundary column, and what its correctness theorem assumes. */
function computeColumn(
  space: SlotSpace,
  scratch: IndexScratch,
  /** This window's non-floor observations as [slot, p, score, …]. */
  obsEntries: number[],
  /** What every state NOT in that list scores — `observationScore(0)`. */
  floorScore: number,
  prevScore: Float64Array | null,
  prevPrevSlot: Int32Array | null,
  cfg: DetectionTemporalConfig,
  debug: boolean,
): Column {
  const { tuneSlots, rank, names, unknownSlot } = space;
  const slotCount = names.length;

  // Scatter this window's handful of real observations; everything else reads
  // the floor without touching memory twice or calling a logarithm.
  const og = ++scratch.obsGenCounter;
  const { obsGen, obsP, obsScore } = scratch;
  for (let k = 0; k < obsEntries.length; k += 3) {
    const slot = obsEntries[k]!;
    obsGen[slot] = og;
    obsP[slot] = obsEntries[k + 1]!;
    obsScore[slot] = obsEntries[k + 2]!;
  }
  const score = new Float64Array(slotCount);
  const prev = new Int32Array(slotCount);
  const debugRow: StepDebugEntry[] = [];
  const pushDebug = (slot: number, p: number, obsScore: number, bestSlot: number, cost: number, total: number) => {
    debugRow.push({
      state: names[slot]!, observation: p, observationScore: obsScore,
      bestPrevious: bestSlot === -1 ? null : names[bestSlot]!, transitionCost: cost, totalScore: total,
    });
  };

  if (prevScore === null) {
    // Canonical order, so a debug row reads the same as the reference's.
    for (let ci = 0; ci < tuneSlots.length; ci++) {
      const slot = tuneSlots[ci]!;
      const hit = obsGen[slot] === og;
      const p = hit ? obsP[slot]! : 0;
      const s = hit ? obsScore[slot]! : floorScore;
      score[slot] = s; prev[slot] = -1;
      if (debug) pushDebug(slot, p, s, -1, 0, s);
    }
    const pu = cfg.unknownObservationProbability;
    const su = observationScore(pu, cfg);
    score[unknownSlot] = su; prev[unknownSlot] = -1;
    if (debug) pushDebug(unknownSlot, pu, su, -1, 0, su);
    return { score, prev, debugRow: debug ? debugRow : undefined };
  }

  const idx = indexPrevRow(tuneSlots, prevScore, prevPrevSlot!, cfg, scratch);
  const unknownScorePrev = scoreAt(prevScore, unknownSlot);
  const unknownRank = rank[unknownSlot]!;

  // The four categories are compared in place rather than gathered into a
  // Candidate[] and handed to a pickBest. Same winner, by the same rule — the
  // four candidate states are provably distinct (same/unknown/unpen/pen are
  // disjoint by construction), so `(value, rank)` is a strict total order over
  // them and a running maximum cannot disagree with a scan.
  for (let ci = 0; ci < tuneSlots.length; ci++) {
    const curSlot = tuneSlots[ci]!;
    let bestValue = scoreAt(prevScore, curSlot) - cfg.sameTuneTransitionCost;
    let bestSlot = curSlot;
    let bestCost = cfg.sameTuneTransitionCost;
    let bestRank = ci;   // a tune's canonical rank IS its position in tuneSlots

    const unknownValue = unknownScorePrev - cfg.unknownToTunePenalty;
    if (unknownValue > bestValue || (unknownValue === bestValue && unknownRank < bestRank)) {
      bestValue = unknownValue; bestSlot = unknownSlot; bestCost = cfg.unknownToTunePenalty; bestRank = unknownRank;
    }

    // The unpen/pen values already have their cost baked in (see indexPrevRow's
    // doc) — do NOT subtract cfg.tuneChangePenalty again here.
    const unpenSlot = bestUnpenalizedExcluding(curSlot, idx, tuneSlots, prevScore, cfg);
    if (unpenSlot !== -1) {
      const v = scratch.unpenValue, r = rank[unpenSlot]!;
      if (v > bestValue || (v === bestValue && r < bestRank)) {
        bestValue = v; bestSlot = unpenSlot; bestCost = cfg.tuneChangePenalty; bestRank = r;
      }
    }
    const penSlot = bestPenalizedFor(curSlot, idx);
    if (penSlot !== -1) {
      const v = scratch.penValue, r = rank[penSlot]!;
      if (v > bestValue || (v === bestValue && r < bestRank)) {
        bestValue = v; bestSlot = penSlot; bestCost = cfg.tuneChangePenalty + cfg.rapidChangePenalty; bestRank = r;
      }
    }

    const hit = obsGen[curSlot] === og;
    const s = hit ? obsScore[curSlot]! : floorScore;
    score[curSlot] = s + bestValue;
    prev[curSlot] = bestSlot;
    if (debug) pushDebug(curSlot, hit ? obsP[curSlot]! : 0, s, bestSlot, bestCost, s + bestValue);
  }

  // UNKNOWN as the current state: same (stay in UNKNOWN) vs the single
  // best tune -> UNKNOWN (no rebound consideration applies to this
  // direction, so idx.bestToUnknown alone is always correct here — its own
  // independent ranking, NOT idx.top1, which is adjusted by a different
  // constant and can disagree at a rounding boundary).
  {
    let bestValue = unknownScorePrev - cfg.unknownStayPenalty;
    let bestSlot = unknownSlot;
    let bestCost = cfg.unknownStayPenalty;
    let bestRank = unknownRank;
    if (idx.bestToUnknownSlot !== -1) {
      const v = idx.bestToUnknownValue, r = rank[idx.bestToUnknownSlot]!;
      if (v > bestValue || (v === bestValue && r < bestRank)) {
        bestValue = v; bestSlot = idx.bestToUnknownSlot; bestCost = cfg.tuneToUnknownPenalty; bestRank = r;
      }
    }
    const p = cfg.unknownObservationProbability;
    const obsScore = observationScore(p, cfg);
    score[unknownSlot] = obsScore + bestValue;
    prev[unknownSlot] = bestSlot;
    if (debug) pushDebug(unknownSlot, p, obsScore, bestSlot, bestCost, obsScore + bestValue);
  }

  return { score, prev, debugRow: debug ? debugRow : undefined };
}

/** Slot-indexed twin of findConvergencePoint/advanceConvergence. `bound` is the
 *  streaming decoder's already-proven frozen point (invariant 4: convergence
 *  only ever advances), which lets the backward scan stop instead of redoing
 *  history; -1 for the unbounded from-scratch case.
 *
 *  A pointer landing on a slot the column predates is HELD IN PLACE rather than
 *  trusted — same defensive choice the Map version documents: per the
 *  correctness theorem this is unreachable, and if it ever were reached, failing
 *  to converge is safe where a corrupted walk is not. */
function convergenceFromSlots(columns: Column[], slotCount: number, T: number, bound: number): number {
  if (T === 0) return -1;
  if (slotCount <= 1) return T - 1;

  let pointer = new Int32Array(slotCount);
  let next = new Int32Array(slotCount);
  for (let s = 0; s < slotCount; s++) pointer[s] = s;

  for (let t = T - 1; t >= 1; t--) {
    const prevCol = columns[t]!.prev;
    const first = pointer[0]!;
    let p0 = prevAt(prevCol, first);
    if (p0 === -1) p0 = first;
    next[0] = p0;
    let allSame = true;
    for (let s = 1; s < slotCount; s++) {
      const cur = pointer[s]!;
      let p = prevAt(prevCol, cur);
      if (p === -1) p = cur;
      next[s] = p;
      if (p !== p0) allSame = false;
    }
    const swap = pointer; pointer = next; next = swap;
    if (allSame) return t - 1;
    if (bound >= 0 && t - 1 <= bound) return bound;
  }
  return -1;
}

/** Slot-indexed twin of buildResult. Scans in CANONICAL order with a strict
 *  `>`, exactly as the reference does, so a tie on the final score picks the
 *  same state. */
function buildResultFromSlots(
  T: number,
  space: SlotSpace,
  columns: Column[],
  debugSteps: StepDebugEntry[][],
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  convergedThroughIndex: number,
  debug: boolean,
): ViterbiResult {
  const lastScore = columns[T - 1]!.score;
  let bestSlot = -1;
  let bestFinalScore = -Infinity;
  for (let ci = 0; ci < space.tuneSlots.length; ci++) {
    const slot = space.tuneSlots[ci]!;
    const sc = scoreAt(lastScore, slot);
    if (sc > bestFinalScore) { bestFinalScore = sc; bestSlot = slot; }
  }
  const su = scoreAt(lastScore, space.unknownSlot);
  if (su > bestFinalScore) { bestFinalScore = su; bestSlot = space.unknownSlot; }

  const slotPath = new Int32Array(T);
  slotPath[T - 1] = bestSlot;
  for (let t = T - 1; t > 0; t--) slotPath[t - 1] = columns[t]!.prev[slotPath[t]!]!;

  const path: string[] = new Array(T);
  for (let t = 0; t < T; t++) path[t] = space.names[slotPath[t]!]!;

  const segments = extractSegments(path, timeline);
  const result: ViterbiResult = {
    segments,
    stats: { numberOfTransitions: segments.length > 0 ? segments.length - 1 : 0, numberOfWindows: T },
    convergedThroughIndex,
  };

  if (debug) {
    result.debug = {
      steps: debugSteps,
      selectedPath: path.map((state, t) => ({
        t,
        time: timeline.windows[t]!.tWindowStart,
        state,
        probability: state === UNKNOWN_STATE ? cfg.unknownObservationProbability : observationAt(timeline, state, t),
        cumulativeScore: columns[t]!.score[slotPath[t]!]!,
      })),
    };
  }
  return result;
}

export function runViterbiDetectionOptimized(
  timeline: TemporalTimeline,
  cfg: DetectionTemporalConfig,
  options: { debug?: boolean } = {},
): ViterbiResult {
  const T = timeline.windows.length;
  if (T === 0) return { segments: [], stats: { numberOfTransitions: 0, numberOfWindows: 0 }, convergedThroughIndex: -1 };

  const debug = !!options.debug;
  const space = syncSlotSpace(null, timeline.tuneIds);
  const scratch = makeIndexScratch(space.names.length);
  const columns: Column[] = [];
  const debugSteps: StepDebugEntry[][] = [];
  const floorScore = observationScore(0, cfg);

  for (let t = 0; t < T; t++) {
    const prevCol = t === 0 ? null : columns[t - 1]!;
    const col = computeColumn(space, scratch, obsEntriesForWindow(space, timeline, t, cfg), floorScore, prevCol && prevCol.score, prevCol && prevCol.prev, cfg, debug);
    columns.push(col);
    if (debug) debugSteps.push(col.debugRow!);
  }

  return buildResultFromSlots(
    T, space, columns, debugSteps, timeline, cfg,
    convergenceFromSlots(columns, space.names.length, T, -1), debug,
  );
}

export const runViterbiDetection = runViterbiDetectionOptimized;

// ═══════════════════════════════════════════════════════════════════════════
// STREAMING decoder — incremental wrapper around computeColumn/advanceConvergence
// for viterbiSegmenter.ts's window-by-window feed. Amortized O(T×S) over a
// whole session instead of the O(T²×S) that repeatedly calling
// runViterbiDetection() from scratch on every window costs (see
// viterbiSegmenter.ts's header for the measured before/after).
//
// ── Correctness (why the incremental result is byte-identical to a from-scratch
// decode over the same windows, not merely an approximation) ──
//
// Relies on four invariants already true of the existing pipeline (NOT
// introduced by this class — see temporalObservationBuilder.ts):
//  1. filterFlatWindows/filterByTempoSpread are pure per-window — window i's
//     filtered form never depends on any other window, so it's fixed the
//     instant it's produced.
//  2. TemporalTimeline.tuneIds only grows as a SET (a tuneId's best-ever score
//     is monotone, so an admitted tune is never dropped) — this order is the
//     canonical tie-break pickBest/stateIndex depend on.
//     ⚠️ CORRECTED 2026-09-13: this used to read "append-only, never
//     reordered". That is FALSE, and measured so. buildTemporalTimeline orders
//     tuneIds by first appearance as a CANDIDATE and applies
//     minCandidateProbability afterwards, so a tune seen early but only
//     admitted later is inserted at its early position and shifts every tune
//     after it. Prefixes of one recording gave [] → [Y] → [Y] → [X, Y]: Y moved
//     from index 0 to index 1. Anything here that caches a position across
//     extend() calls must rebuild when the set changes — see this class's
//     stateIndex, where assuming append-only made the tie-prone equivalence
//     oracle fail immediately.
//  3. bestScore[t] is a pure function of bestScore[t-1] and window t alone —
//     never the future — so a cached column, once computed, never needs
//     revising.
//  4. Convergence (findConvergencePoint) is monotone: once two backtrack
//     pointers merge, they never diverge again — see its doc.
//
// The correctness argument for seeding a newly-discovered state to
// -Infinity in the previous cached column (rather than replaying its true
// epsilon-floored history from t=0, as a from-scratch decode implicitly
// does): when tune X first joins tuneIds at window t0, buildTemporalTimeline
// zero-fills its observations for every window < t0. In a from-scratch
// decode, X therefore "exists" from t=0 with a finite but massively negative
// forward score there (log(epsilon) accumulated every step). The ONLY
// question that matters is whether X's own epsilon-chain ever wins an argmax
// — either as X's own best predecessor, or as some OTHER state's chosen
// predecessor. It never does: entering X (or leaving X) is always dominated
// by entering/leaving via a real predecessor (or UNKNOWN) paying the normal
// transition cost, whose score is incomparably higher than epsilon's
// log(1e-6)-ish accumulation. So: (a) a from-scratch decode always enters X
// at t0 via a REAL predecessor, not X's own epsilon chain — the streaming
// decoder's -Infinity seed produces the exact same choice; (b) a from-scratch
// decode never routes any OTHER state's transition through X-epsilon — a
// seeded -Infinity can't either, it always loses. So every column computed
// WITHOUT X before t0 is numerically identical to a from-scratch column
// computed WITH X before t0, for every state ≠ X. Corollary: no optimal
// backtrack pointer ever targets a -Infinity-seeded cell (never argmax), so
// backtracking and convergence-scanning never visit a state before its real
// birth. This holds ONLY for a state joining at t0>0 (epsilon history to
// seed away) — a state present since window 0 has real observations from
// the start, nothing to seed.

/** First mismatch description between two ViterbiResults over the SAME
 *  timeline, or null if they agree — path (segments) AND scores
 *  (per-segment probability stats) AND convergence. Used only by the
 *  dev-only shadow-assert below; not part of the production hot path. */
export function describeViterbiDivergence(streaming: ViterbiResult, reference: ViterbiResult): string | null {
  if (streaming.segments.length !== reference.segments.length) {
    return `segment count: streaming=${streaming.segments.length} reference=${reference.segments.length}`;
  }
  for (let i = 0; i < streaming.segments.length; i++) {
    const s = streaming.segments[i]!, r = reference.segments[i]!;
    // NaN-safe: `Math.abs(NaN - x) > tolerance` is always false (NaN
    // comparisons never true), so a leaked NaN would otherwise silently
    // read as "no difference" — checked explicitly first.
    const probs = [s.confidence, s.averageProbability, s.minimumProbability, s.maximumProbability];
    if (probs.some(v => !Number.isFinite(v))) {
      return `segment[${i}]: non-finite probability leaked into streaming segment stats: ${JSON.stringify(s)}`;
    }
    if (
      s.tuneId !== r.tuneId || s.startTime !== r.startTime || s.endTime !== r.endTime
      || s.firstWindowIndex !== r.firstWindowIndex || s.windowCount !== r.windowCount
      || Math.abs(s.averageProbability - r.averageProbability) > 1e-9
      || Math.abs(s.minimumProbability - r.minimumProbability) > 1e-9
      || Math.abs(s.maximumProbability - r.maximumProbability) > 1e-9
    ) {
      return `segment[${i}]: streaming=${JSON.stringify(s)} reference=${JSON.stringify(r)}`;
    }
  }
  if (streaming.stats.numberOfTransitions !== reference.stats.numberOfTransitions) {
    return `numberOfTransitions: streaming=${streaming.stats.numberOfTransitions} reference=${reference.stats.numberOfTransitions}`;
  }
  if (streaming.convergedThroughIndex !== reference.convergedThroughIndex) {
    return `convergedThroughIndex: streaming=${streaming.convergedThroughIndex} reference=${reference.convergedThroughIndex}`;
  }
  return null;
}

export class StreamingViterbiDecoder {
  private columns: Column[] = [];
  private debugSteps: StepDebugEntry[][] = [];
  /** Slots are what make caching columns safe across calls — see the slot doc
   *  near SlotSpace. Extended, never renumbered. */
  private space: SlotSpace | null = null;
  private scratch = makeIndexScratch(0);
  private frozenThrough = -1;
  private readonly debug: boolean;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = !!options.debug;
  }

  /** Extends the decode to cover `timeline` (which always describes the FULL
   *  window history so far — see viterbiSegmenter.ts's recompute(), same
   *  contract runViterbiDetection() always had) and returns the up-to-date
   *  ViterbiResult. Cheap to call every window: only ever computes the
   *  columns and convergence range that are actually new. */
  extend(timeline: TemporalTimeline, cfg: DetectionTemporalConfig): ViterbiResult {
    const T = timeline.windows.length;
    if (T === 0) return { segments: [], stats: { numberOfTransitions: 0, numberOfWindows: 0 }, convergedThroughIndex: -1 };

    // Extends the slot space and refreshes the tie-break ranks. No
    // boundary column to patch any more: a cached column simply has no cell for
    // a slot that did not exist when it was computed, and scoreAt/prevAt answer
    // -Infinity / -1 there — which is the seeding this used to write by hand,
    // and exactly what the correctness theorem above assumes.
    this.space = syncSlotSpace(this.space, timeline.tuneIds);
    const space = this.space;
    if (this.scratch.groupGen.length !== space.names.length) {
      this.scratch = makeIndexScratch(space.names.length);
    }

    // Built per NEW window only — the ones already decoded are never read
    // again — from that window's ~10 candidates, not from every admitted tune.
    const floorScore = observationScore(0, cfg);

    for (let t = this.columns.length; t < T; t++) {
      const prevCol = t === 0 ? null : this.columns[t - 1]!;
      const col = computeColumn(
        space, this.scratch, obsEntriesForWindow(space, timeline, t, cfg), floorScore,
        prevCol && prevCol.score, prevCol && prevCol.prev, cfg, this.debug,
      );
      this.columns.push(col);
      if (this.debug) this.debugSteps.push(col.debugRow!);
    }

    this.frozenThrough = convergenceFromSlots(this.columns, space.names.length, T, this.frozenThrough);

    return buildResultFromSlots(T, space, this.columns, this.debugSteps, timeline, cfg, this.frozenThrough, this.debug);
  }
}
