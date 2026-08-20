import { describe, it, expect } from 'vitest';
import { runViterbiDetectionOptimized, runViterbiDetectionReference } from './viterbiDetector';
import { buildTemporalTimeline, UNKNOWN_STATE } from './temporalObservationBuilder';
import type { DetectionTemporalConfig } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

// ── The 12 required cases from the 2026-08-14 O(T×S) optimization spec ─────
// Exercises the optimized implementation's specific internal mechanics
// (self-exclusion fallback, UNKNOWN-as-best-predecessor, the rapid-change
// "pen" group, near-ties) — general path correctness across many random
// inputs is covered separately by viterbiDetectorEquivalence.test.ts.

const HOP = 5;

const TEST_CFG: DetectionTemporalConfig = {
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
  minSegmentWindows: 2,
  sameTuneMergeGapWindows: 10,
  flatWindowTopN: 3,
  flatWindowMarginThreshold: 0, // disabled — this file never calls filterFlatWindows
  tempoSpreadThreshold: 0, // disabled — this file never calls filterByTempoSpread
};

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

function fromSeries(series: Record<string, number[]>): WindowResult[] {
  const n = Math.max(...Object.values(series).map(a => a.length));
  const windows: WindowResult[] = [];
  for (let i = 0; i < n; i++) {
    const candidates = Object.entries(series)
      .map(([id, scores]) => (scores[i] ?? 0) > 0 ? cand(id, scores[i]!) : null)
      .filter((c): c is WindowCandidate => c !== null);
    windows.push(win(i, candidates));
  }
  return windows;
}

function detectOptimized(series: Record<string, number[]>, cfg: DetectionTemporalConfig = TEST_CFG) {
  const windows = fromSeries(series);
  const timeline = buildTemporalTimeline(windows, cfg);
  return runViterbiDetectionOptimized(timeline, cfg, { debug: true });
}

function path(result: ReturnType<typeof detectOptimized>): string[] {
  return result.segments.flatMap(s => Array(s.windowCount).fill(s.tuneId));
}

/** Cross-checks optimized against reference on the same input, for cases
 *  where hand-deriving the exact expected float outcome isn't the point —
 *  the point is that the optimization's fast path handles this shape of
 *  input identically to the exhaustive scan. */
function expectMatchesReference(windows: WindowResult[], cfg: DetectionTemporalConfig = TEST_CFG) {
  const timeline = buildTemporalTimeline(windows, cfg);
  const ref = runViterbiDetectionReference(timeline, cfg, { debug: true });
  const opt = runViterbiDetectionOptimized(timeline, cfg, { debug: true });
  expect(opt.debug!.selectedPath.map(e => e.state)).toEqual(ref.debug!.selectedPath.map(e => e.state));
  expect(opt.segments).toEqual(ref.segments);
  return opt;
}

describe('runViterbiDetectionOptimized — the 12 required cases', () => {
  it('1. single tune throughout', () => {
    const r = detectOptimized({ A: [0.9, 0.9, 0.9, 0.9, 0.9] });
    expect(path(r)).toEqual(['A', 'A', 'A', 'A', 'A']);
  });

  it('2. several tunes, clean transition', () => {
    const r = detectOptimized({
      A: [0.9, 0.9, 0.9, 0.05, 0.05, 0.05],
      B: [0.05, 0.05, 0.05, 0.9, 0.9, 0.9],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
  });

  it('3. isolated moderate false positive does not break continuity', () => {
    const r = detectOptimized({
      A: [0.85, 0.85, 0.85, 0.4, 0.85, 0.85, 0.85],
      B: [0, 0, 0, 0.5, 0, 0, 0],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'A', 'A', 'A', 'A']);
  });

  it('4. UNKNOWN in the middle (genuine silence between two tunes)', () => {
    const r = detectOptimized({
      A: [0.9, 0.9, 0.05, 0.05, 0.02, 0.02],
      B: [0.02, 0.02, 0.05, 0.05, 0.9, 0.9],
    });
    expect(r.segments.map(s => s.tuneId)).toEqual(['A', UNKNOWN_STATE, 'B']);
  });

  it('5. UNKNOWN at the start', () => {
    const r = detectOptimized({ A: [0.02, 0.02, 0.9, 0.9, 0.9] });
    expect(r.segments.map(s => s.tuneId)).toEqual([UNKNOWN_STATE, 'A']);
  });

  it('6. UNKNOWN at the end', () => {
    const r = detectOptimized({ A: [0.9, 0.9, 0.9, 0.02, 0.02] });
    expect(r.segments.map(s => s.tuneId)).toEqual(['A', UNKNOWN_STATE]);
  });

  it('7. rapid change A -> B -> A over the minimal 3-window span is rejected', () => {
    const r = detectOptimized({
      A: [0.9, 0.3, 0.9],
      B: [0.05, 0.95, 0.05],
    });
    expect(path(r)).toEqual(['A', 'A', 'A']);
  });

  it('8. several candidates with close scores', () => {
    // A stays narrowly ahead of B and C throughout — should hold A, not flap.
    const r = detectOptimized({
      A: [0.52, 0.53, 0.51, 0.54, 0.52],
      B: [0.48, 0.47, 0.49, 0.46, 0.48],
      C: [0.45, 0.44, 0.46, 0.43, 0.45],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'A', 'A']);
  });

  it('9. the global best-previous is exactly the current state — must correctly fall through to the second-best for "different tune"', () => {
    // A dominates throughout (so A is always its own best "same" predecessor,
    // and also the global top score) — but a real transition to B still must
    // find its way via the SECOND-best predecessor, not incorrectly reuse A
    // as if it were a valid "different tune" source.
    const r = detectOptimized({
      A: [0.95, 0.95, 0.95, 0.1, 0.1, 0.1],
      B: [0.05, 0.05, 0.05, 0.93, 0.93, 0.93],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
    // Cross-check against the exhaustive reference for this exact shape.
    expectMatchesReference(fromSeries({
      A: [0.95, 0.95, 0.95, 0.1, 0.1, 0.1],
      B: [0.05, 0.05, 0.05, 0.93, 0.93, 0.93],
    }));
  });

  it('10. UNKNOWN is genuinely the best predecessor for entering a tune', () => {
    // A long, unambiguous silence, THEN a real tune starts — the winning
    // predecessor for B's first strong window must be UNKNOWN, not some
    // leftover weak tune candidate.
    const windows = fromSeries({
      A: [0.05, 0.05, 0.05, 0.05, 0.05, 0.9, 0.9],
      B: [0.05, 0.05, 0.05, 0.05, 0.05, 0.02, 0.02],
    });
    const opt = expectMatchesReference(windows);
    const idx = opt.debug!.selectedPath.findIndex(e => e.state === 'A');
    expect(idx).toBeGreaterThan(0);
    // The step where A first wins must have transitioned in from UNKNOWN.
    const stepEntries = opt.debug!.steps[idx]!;
    const aEntry = stepEntries.find(e => e.state === 'A')!;
    expect(aEntry.bestPrevious).toBe(UNKNOWN_STATE);
  });

  it('11. rapidChangePenalty specifically changes the outcome (with vs without it)', () => {
    const series = {
      A: [0.9, 0.10, 0.9],
      B: [0.05, 0.90, 0.05],
    };
    const withPenalty = detectOptimized(series, TEST_CFG);
    const withoutPenalty = detectOptimized(series, { ...TEST_CFG, rapidChangePenalty: 0 });
    expect(path(withPenalty)).toEqual(['A', 'A', 'A']); // bounce rejected
    expect(path(withoutPenalty)).toEqual(['A', 'B', 'A']); // bounce accepted once the surcharge is removed
  });

  it('12. best and second-best previous states are very close — still matches the reference exactly', () => {
    const windows = fromSeries({
      A: [0.9, 0.501, 0.9, 0.9],
      B: [0.05, 0.499, 0.05, 0.05],
      C: [0.05, 0.500, 0.05, 0.05],
    });
    expectMatchesReference(windows);
  });
});
