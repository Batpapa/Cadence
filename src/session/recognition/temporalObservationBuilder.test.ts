import { describe, it, expect } from 'vitest';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, IncrementalTimelineBuilder, describeTimelineDivergence } from './temporalObservationBuilder';
import { DETECTION_TEMPORAL_CONFIG } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

const HOP = 5;

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

/** Same as win(), plus debug.features.tempo_candidates built from raw combined_scores. */
function winWithTempo(i: number, candidates: WindowCandidate[], tempoScores: number[]): WindowResult {
  return {
    ...win(i, candidates),
    debug: {
      contour: null,
      octaveShiftApplied: 0,
      features: {
        note_count_raw: 0, note_count_filtered: 0, note_count_rejected: 0,
        note_duration_mean: 0, note_duration_median: 0,
        note_power_mean: 0, note_power_max: 0, note_power_median: 0,
        best_bpm: 0, best_quant_score: 0, best_rhythm_score: 0, best_combined_score: 0,
        contour_length: 0,
        tempo_candidates: tempoScores.map((combined_score, bpmIdx) => ({
          bpm: 60 + bpmIdx * 5, quant_score: 0, rhythm_score: 0, combined_score,
        })),
      },
    },
  };
}

describe('buildTemporalTimeline', () => {
  it('zero-fills a tuneId absent from a window rather than skipping it', () => {
    const windows = [win(0, [cand('A', 0.9)]), win(1, []), win(2, [cand('A', 0.8)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.observations.get('A')).toEqual([0.9, 0, 0.8]);
  });

  it('keeps a tune whose best score is only reached in a later window', () => {
    const windows = [win(0, [cand('A', 0.1)]), win(1, [cand('A', 0.15)]), win(2, [cand('A', 0.9)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.tuneIds).toContain('A');
    expect(t.observations.get('A')).toEqual([0.1, 0.15, 0.9]);
  });

  it('drops a tune whose best-ever score never clears minCandidateProbability', () => {
    const windows = [win(0, [cand('A', 0.05)]), win(1, [cand('A', 0.1)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.tuneIds).not.toContain('A');
    expect(t.observations.has('A')).toBe(false);
  });

  it('records the 1-based rank per window, null where absent', () => {
    const windows = [win(0, [cand('A', 0.9), cand('B', 0.8)]), win(1, [cand('B', 0.7)])];
    const t = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(t.ranks.get('A')).toEqual([1, null]);
    expect(t.ranks.get('B')).toEqual([2, 1]);
  });
});

describe('filterFlatWindows', () => {
  it('flattens a window whose top1-topN margin is below the threshold', () => {
    const windows = [win(0, [cand('A', 0.50), cand('B', 0.48), cand('C', 0.47)])];
    const out = filterFlatWindows(windows, 3, 0.05);
    expect(out[0]!.candidates).toEqual([]);
    expect(out[0]!.empty).toBe(true);
  });

  it('leaves a window alone whose margin clears the threshold', () => {
    const windows = [win(0, [cand('A', 0.50), cand('B', 0.30), cand('C', 0.20)])];
    const out = filterFlatWindows(windows, 3, 0.05);
    expect(out[0]!.candidates).toHaveLength(3);
    expect(out[0]!.empty).toBe(false);
  });

  it('compares top1 against the topN-th candidate specifically, not top2', () => {
    // top1-top2 gap is tiny (0.01, below threshold) but top1-top3 clears it —
    // this is exactly the "two homonym tuneIds tied for 1st" case topN=3 was
    // chosen to tolerate (see detectionTemporalConfig.ts).
    const windows = [win(0, [cand('A', 0.50), cand('A2', 0.49), cand('B', 0.10)])];
    const out2 = filterFlatWindows(windows, 2, 0.05);
    expect(out2[0]!.candidates).toEqual([]); // topN=2: 0.50-0.49=0.01 < 0.05 -> flattened

    const out3 = filterFlatWindows(windows, 3, 0.05);
    expect(out3[0]!.candidates).toHaveLength(3); // topN=3: 0.50-0.10=0.40 >= 0.05 -> untouched
  });

  it('leaves a window with fewer than topN candidates untouched', () => {
    const windows = [win(0, [cand('A', 0.50), cand('B', 0.49)])];
    const out = filterFlatWindows(windows, 3, 0.05);
    expect(out[0]!.candidates).toHaveLength(2);
  });

  it('does not mutate the input array or its windows', () => {
    const windows = [win(0, [cand('A', 0.50), cand('B', 0.48), cand('C', 0.47)])];
    const snapshot = JSON.parse(JSON.stringify(windows));
    filterFlatWindows(windows, 3, 0.05);
    expect(windows).toEqual(snapshot);
  });

  it('treats the threshold as exclusive at the boundary (gap == threshold is NOT flattened)', () => {
    const windows = [win(0, [cand('A', 0.55), cand('B', 0.50), cand('C', 0.10)])];
    const out = filterFlatWindows(windows, 2, 0.05);
    expect(out[0]!.candidates).toHaveLength(3);
  });
});

describe('filterByTempoSpread', () => {
  it('flattens a window whose tempo-candidate score spread is below the threshold', () => {
    // Near-constant score across every tempo tried -> tiny std dev -> "tempo-agnostic".
    const windows = [winWithTempo(0, [cand('A', 0.5)], [0.40, 0.41, 0.39, 0.40, 0.41])];
    const out = filterByTempoSpread(windows, 0.10);
    expect(out[0]!.candidates).toEqual([]);
    expect(out[0]!.empty).toBe(true);
  });

  it('leaves a window alone whose tempo-candidate spread clears the threshold', () => {
    const windows = [winWithTempo(0, [cand('A', 0.5)], [0.10, 0.90, 0.20, 0.85, 0.15])];
    const out = filterByTempoSpread(windows, 0.10);
    expect(out[0]!.candidates).toHaveLength(1);
    expect(out[0]!.empty).toBe(false);
  });

  it('leaves a window untouched when it has no debug tempo data at all (pre-instrumentation sessions, or too-few-notes windows)', () => {
    const windows = [win(0, [cand('A', 0.5), cand('B', 0.4)])]; // no .debug at all
    const out = filterByTempoSpread(windows, 0.10);
    expect(out[0]!.candidates).toHaveLength(2);
  });

  it('does not mutate the input array or its windows', () => {
    const windows = [winWithTempo(0, [cand('A', 0.5)], [0.40, 0.41, 0.39])];
    const snapshot = JSON.parse(JSON.stringify(windows));
    filterByTempoSpread(windows, 0.10);
    expect(windows).toEqual(snapshot);
  });
});

// ── IncrementalTimelineBuilder ──────────────────────────────────────────────
// The broader randomized "matches buildTemporalTimeline at every step" oracle
// lives in temporalTimelineStreamingEquivalence.test.ts (mirrors
// viterbiStreamingEquivalence.test.ts's structure/role). These tests target
// the two specific correctness traps called out in its header doc directly,
// plus basic push()/current()/length behavior.
describe('IncrementalTimelineBuilder', () => {
  it('matches buildTemporalTimeline at every step for a simple growing sequence', () => {
    const windows = [win(0, [cand('A', 0.9), cand('B', 0.3)]), win(1, [cand('B', 0.8)]), win(2, [cand('A', 0.1), cand('C', 0.5)])];
    const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
    for (let t = 1; t <= windows.length; t++) {
      const incremental = builder.push(windows[t - 1]!);
      const reference = buildTemporalTimeline(windows.slice(0, t), DETECTION_TEMPORAL_CONFIG);
      expect(describeTimelineDivergence(incremental, reference)).toBeNull();
    }
  });

  it('piège A: tuneIds are in FIRST-APPEARANCE order, not crossing-threshold order', () => {
    // Window 0: A appears but stays below minCandidateProbability (0.20);
    // B appears and clears it immediately. Window 1: A finally clears too.
    // Crossing order would be [B, A]; first-appearance order (the correct
    // one, matching buildTemporalTimeline's Map-insertion-order semantics)
    // is [A, B].
    const windows = [win(0, [cand('A', 0.05), cand('B', 0.9)]), win(1, [cand('A', 0.9)])];
    const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
    builder.push(windows[0]!);
    const timeline = builder.push(windows[1]!);
    expect(timeline.tuneIds).toEqual(['A', 'B']);
    const reference = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(reference.tuneIds).toEqual(['A', 'B']);
    expect(describeTimelineDivergence(timeline, reference)).toBeNull();
  });

  it('piège B: a tuneId that crosses the threshold late keeps its real pre-crossing history, not zeros', () => {
    const windows = [win(0, [cand('X', 0.05)]), win(1, [cand('X', 0.06)]), win(2, [cand('X', 0.9)])];
    const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
    let timeline;
    for (const w of windows) timeline = builder.push(w);
    expect(timeline!.observations.get('X')).toEqual([0.05, 0.06, 0.9]);
    const reference = buildTemporalTimeline(windows, DETECTION_TEMPORAL_CONFIG);
    expect(describeTimelineDivergence(timeline!, reference)).toBeNull();
  });

  it('length reflects the number of windows pushed; current() returns the same view as the last push()', () => {
    const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
    expect(builder.length).toBe(0);
    const pushed = builder.push(win(0, [cand('A', 0.9)]));
    expect(builder.length).toBe(1);
    expect(builder.current()).toEqual(pushed);
  });

  it('cleared tuneIds not present in a window are zero/null-filled for it, same as buildTemporalTimeline', () => {
    const windows = [win(0, [cand('A', 0.9)]), win(1, []), win(2, [cand('A', 0.8)])];
    const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
    let timeline;
    for (const w of windows) timeline = builder.push(w);
    expect(timeline!.observations.get('A')).toEqual([0.9, 0, 0.8]);
    expect(timeline!.ranks.get('A')).toEqual([1, null, 1]);
  });

  it('drops a tuneId whose best-ever score never clears minCandidateProbability, same as buildTemporalTimeline', () => {
    const windows = [win(0, [cand('A', 0.05)]), win(1, [cand('A', 0.1)])];
    const builder = new IncrementalTimelineBuilder(DETECTION_TEMPORAL_CONFIG);
    let timeline;
    for (const w of windows) timeline = builder.push(w);
    expect(timeline!.tuneIds).not.toContain('A');
    expect(timeline!.observations.has('A')).toBe(false);
  });
});
