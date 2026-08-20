import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { runViterbiDetection, filterShortSegments, countTop1Windows, type DetectedTuneSegment } from './viterbiDetector';
import { buildTemporalTimeline, UNKNOWN_STATE, type TemporalTimeline } from './temporalObservationBuilder';
import type { DetectionTemporalConfig } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate } from '../model';

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Builds windows from parallel per-tune score arrays, e.g. { A: [.9,.9,.1], B: [.1,.1,.9] }. */
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

function detect(series: Record<string, number[]>, cfg: DetectionTemporalConfig = TEST_CFG) {
  const windows = fromSeries(series);
  const timeline = buildTemporalTimeline(windows, cfg);
  return runViterbiDetection(timeline, cfg);
}

function path(result: ReturnType<typeof detect>): string[] {
  return result.segments.flatMap(s => Array(s.windowCount).fill(s.tuneId));
}

// ── Tests (section 20 of the 2026-08-13 spec) ───────────────────────────────

describe('runViterbiDetection', () => {
  it('case 1 — constant tune produces one unbroken segment', () => {
    const r = detect({ A: [0.9, 0.9, 0.9, 0.9, 0.9] });
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.tuneId).toBe('A');
    expect(r.segments[0]!.windowCount).toBe(5);
    expect(r.segments[0]!.startTime).toBe(0); // window 0's own tWindowStart
    expect(r.segments[0]!.endTime).toBe(35);  // window 4's own tWindowEnd (4*HOP + windowSeconds)
  });

  it('case 2 — clear change produces exactly one transition A -> B, with the segments overlapping by design', () => {
    const r = detect({
      A: [0.9, 0.9, 0.9, 0.05, 0.05, 0.05],
      B: [0.05, 0.05, 0.05, 0.9, 0.9, 0.9],
    });
    expect(r.segments.map(s => s.tuneId)).toEqual(['A', 'B']);
    expect(r.segments[0]!.windowCount).toBe(3);
    expect(r.segments[1]!.windowCount).toBe(3);
    // A covers windows 0-2: [0, 25). B covers windows 3-5: [15, 40). Analysis
    // windows overlap each other by (windowSeconds - stepSeconds) = 10s, so
    // two segments meeting at a clean transition overlap by that same 10s —
    // this is intentional (see DetectedTuneSegment's doc), not a bug to trim.
    expect(r.segments[0]!.startTime).toBe(0);
    expect(r.segments[0]!.endTime).toBe(25);
    expect(r.segments[1]!.startTime).toBe(15);
    expect(r.segments[1]!.endTime).toBe(40);
    expect(r.segments[1]!.startTime).toBeLessThan(r.segments[0]!.endTime);
  });

  it('case 3 — isolated moderate false positive does not break continuity', () => {
    const r = detect({
      A: [0.85, 0.85, 0.85, 0.4, 0.85, 0.85, 0.85],
      B: [0, 0, 0, 0.5, 0, 0, 0],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'A', 'A', 'A', 'A']);
  });

  it('case 4 — a real, sustained transition still happens despite the switch penalty', () => {
    const r = detect({
      A: [0.9, 0.9, 0.9, 0.05, 0.05, 0.05],
      B: [0.05, 0.05, 0.05, 0.95, 0.95, 0.95],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
  });

  it('case 5 — a genuine low-confidence stretch is labelled UNKNOWN, not forced onto a tune', () => {
    const r = detect({
      A: [0.9, 0.9, 0.05, 0.05, 0.02, 0.02],
      B: [0.02, 0.02, 0.05, 0.05, 0.9, 0.9],
    });
    expect(r.segments.map(s => s.tuneId)).toEqual(['A', UNKNOWN_STATE, 'B']);
  });

  it('case 6 — a single-window dip to a rival tune is rejected (rapid-change penalty)', () => {
    const r = detect({
      A: [0.9, 0.9, 0.3, 0.9, 0.9],
      B: [0.05, 0.05, 0.95, 0.05, 0.05],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'A', 'A']);
  });

  it('case 7 — a marginal tie does not flip the pick, but a later clear win does transition', () => {
    const r = detect({
      A: [0.85, 0.85, 0.55, 0.20, 0.10, 0.10],
      B: [0.05, 0.05, 0.52, 0.90, 0.90, 0.90],
    });
    expect(path(r)).toEqual(['A', 'A', 'A', 'B', 'B', 'B']);
  });

  it('case 8 — no confident candidate anywhere yields UNKNOWN throughout, never an arbitrary tune', () => {
    const r = detect({ A: [0.05, 0.08, 0.06] });
    expect(path(r)).toEqual([UNKNOWN_STATE, UNKNOWN_STATE, UNKNOWN_STATE]);
  });

  it('a tune sitting just below the UNKNOWN baseline can still win over a long-enough stretch — the stay costs are asymmetric (sameTuneTransitionCost=0 vs unknownStayPenalty>0), so this is a real property of the current defaults, not a bug', () => {
    const r = detect({ A: Array(10).fill(0.22) }); // clears minCandidateProbability but below unknownObservationProbability
    expect(path(r)).toEqual(Array(10).fill('A'));
  });

  it('debug mode reports one entry per candidate state per window, plus the winning path', () => {
    const windows = fromSeries({ A: [0.9, 0.9], B: [0.1, 0.1] });
    const timeline = buildTemporalTimeline(windows, TEST_CFG);
    const r = runViterbiDetection(timeline, TEST_CFG, { debug: true });
    expect(r.debug).toBeDefined();
    expect(r.debug!.steps).toHaveLength(2);
    expect(r.debug!.steps[0]!.map(e => e.state).sort()).toEqual(['A', UNKNOWN_STATE].sort());
    expect(r.debug!.selectedPath).toHaveLength(2);
  });
});

// ── Segment timestamps = raw observation-window span (overlap preserved) ───
// Regression guard (2026-08-15). An EARLIER same-day change made segments
// disjoint/contiguous (never overlapping) — that was WRONG and has been
// reverted: analysis windows are windowSeconds (15s) wide, taken every
// stepSeconds (5s), so they overlap their neighbours by 10s, and a segment's
// startTime/endTime are meant to reflect exactly the observation window span
// that produced it (windows[firstIdx].tWindowStart .. windows[lastIdx].tWindowEnd
// — see windowRangeToTime's doc), NOT a claim about the tune's real start/end
// down to the second. Two segments from a clean back-to-back transition
// therefore legitimately overlap by up to that same 10s — this suite proves
// that (a) segment boundaries are always exactly the underlying windows' own
// raw timestamps (never adjusted/clamped/forced apart) and (b) a transition
// like `A: 0->15, B: 10->45` must NOT be truncated into `A: 0->10, B: 10->45`
// by any future change.

/** Walks `segments` (assumed, like extractSegments produces, to cover
 *  consecutive runs of `windows` in order) and asserts every boundary is
 *  read verbatim from the underlying windows — start = the run's first
 *  window's own tWindowStart, end = the run's last window's own tWindowEnd.
 *  This is the CORRECT invariant now (replacing the old, wrong "must never
 *  overlap" one): it fails if a future change synthesizes/adjusts a boundary
 *  instead of using the raw window timestamp. */
function expectRawSpans(segments: DetectedTuneSegment[], windows: WindowResult[]): void {
  let offset = 0;
  for (const s of segments) {
    expect(s.startTime).toBe(windows[offset]!.tWindowStart);
    expect(s.endTime).toBe(windows[offset + s.windowCount - 1]!.tWindowEnd);
    offset += s.windowCount;
  }
  expect(offset).toBe(windows.length);
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWindowsFor(rng: () => number, T: number, tuneIds: string[]): WindowResult[] {
  const windows: WindowResult[] = [];
  for (let i = 0; i < T; i++) {
    const candidates: WindowCandidate[] = [];
    for (const id of tuneIds) {
      if (rng() < 0.5) candidates.push(cand(id, rng()));
    }
    windows.push(win(i, candidates));
  }
  return windows;
}

/** Same shape as win(), but with a real-world-jitter-style irregular step
 *  (never exactly HOP apart) and a narrower window 0 — the real app no
 *  longer produces a narrower first window (2026-08-15: it now waits for a
 *  full ANALYSIS_WINDOW_S before the very first analysis, same as every
 *  other window), but the boundary formula must still be correct for ANY
 *  window widths/spacing, not just today's uniform case — it must come
 *  straight from each window's own real timestamps, never a synthetic
 *  `index * stepSeconds` grid. */
function jitteredWindows(rng: () => number, T: number, candidatesAt: (i: number) => WindowCandidate[]): WindowResult[] {
  const windows: WindowResult[] = [];
  let t = 0;
  for (let i = 0; i < T; i++) {
    const step = HOP + (rng() - 0.5) * 2; // HOP ± 1s
    t = i === 0 ? 0 : t + step;
    const width = i === 0 ? 10 : 15; // window 0 truncated, like the real app
    windows.push({ tWindowStart: t, tWindowEnd: t + width, empty: false, candidates: candidatesAt(i) });
  }
  return windows;
}

describe('segment timestamps reflect raw observation-window spans (overlap is expected and preserved)', () => {
  it('every hand-built case above produces segments whose bounds are exactly the raw window timestamps', () => {
    const cases: Record<string, number[]>[] = [
      { A: [0.9, 0.9, 0.9, 0.9, 0.9] },
      { A: [0.9, 0.9, 0.9, 0.05, 0.05, 0.05], B: [0.05, 0.05, 0.05, 0.9, 0.9, 0.9] },
      { A: [0.85, 0.85, 0.85, 0.4, 0.85, 0.85, 0.85], B: [0, 0, 0, 0.5, 0, 0, 0] },
      { A: [0.9, 0.9, 0.9, 0.05, 0.05, 0.05], B: [0.05, 0.05, 0.05, 0.95, 0.95, 0.95] },
      { A: [0.9, 0.9, 0.05, 0.05, 0.02, 0.02], B: [0.02, 0.02, 0.05, 0.05, 0.9, 0.9] },
      { A: [0.9, 0.9, 0.3, 0.9, 0.9], B: [0.05, 0.05, 0.95, 0.05, 0.05] },
      { A: [0.85, 0.85, 0.55, 0.20, 0.10, 0.10], B: [0.05, 0.05, 0.52, 0.90, 0.90, 0.90] },
      { A: [0.05, 0.08, 0.06] },
    ];
    for (const series of cases) {
      const windows = fromSeries(series);
      const timeline = buildTemporalTimeline(windows, TEST_CFG);
      expectRawSpans(runViterbiDetection(timeline, TEST_CFG).segments, windows);
    }
  });

  it('a clean back-to-back transition (windows[3] is the first to flip) overlaps by exactly windowSeconds - stepSeconds, and must never be truncated to disjoint', () => {
    // Mirrors the exact shape flagged as a false "bug" (2026-08-15): tune A
    // confidently covers windows 0-3, tune B confidently covers windows 4-7,
    // with no UNKNOWN gap between them — a real back-to-back set change.
    const windows = fromSeries({
      A: [0.9, 0.92, 0.91, 0.93, 0.05, 0.05, 0.05, 0.05],
      B: [0.05, 0.05, 0.05, 0.05, 0.9, 0.92, 0.91, 0.93],
    });
    const timeline = buildTemporalTimeline(windows, TEST_CFG);
    const r = runViterbiDetection(timeline, TEST_CFG);
    expect(r.segments.map(s => s.tuneId)).toEqual(['A', 'B']);
    expectRawSpans(r.segments, windows);

    const [a, b] = r.segments as [DetectedTuneSegment, DetectedTuneSegment];
    expect(a.startTime).toBe(0);
    expect(a.endTime).toBe(30);  // windows[3].tWindowEnd = 3*5 + 15
    expect(b.startTime).toBe(20); // windows[4].tWindowStart = 4*5
    expect(b.endTime).toBe(50);  // windows[7].tWindowEnd = 7*5 + 15
    // The overlap is real and must be preserved, never trimmed: if a future
    // change forces these apart (e.g. clamps a.endTime down to b.startTime,
    // or vice versa), this is exactly what must fail.
    expect(b.startTime).toBeLessThan(a.endTime);
    expect(a.endTime - b.startTime).toBe(10); // windowSeconds(15) - stepSeconds(5)
  });

  it('holds across randomized fuzzing (uniform grid, many tunes, frequent UNKNOWN interleaving)', () => {
    const rng = mulberry32(20260815);
    for (let iter = 0; iter < 300; iter++) {
      const T = 5 + Math.floor(rng() * 60);
      const numTunes = 1 + Math.floor(rng() * 5);
      const tuneIds = Array.from({ length: numTunes }, (_, i) => `T${i}`);
      const windows = randomWindowsFor(rng, T, tuneIds);
      const timeline = buildTemporalTimeline(windows, TEST_CFG);
      const r = runViterbiDetection(timeline, TEST_CFG);
      expectRawSpans(r.segments, windows);
    }
  });

  it('holds on a non-uniform ("jittered") window grid with a truncated first window, like real live capture', () => {
    const rng = mulberry32(2026815);
    const windows = jitteredWindows(rng, 40, i => {
      const tuneId = i < 20 ? 'A' : 'B';
      return [cand(tuneId, 0.85 + rng() * 0.1)];
    });
    const timeline = buildTemporalTimeline(windows, TEST_CFG);
    const r = runViterbiDetection(timeline, TEST_CFG);
    expectRawSpans(r.segments, windows);
    expect(r.segments.map(s => s.tuneId)).toEqual(['A', 'B']);
    // The A -> B boundary must land exactly on the real (jittered, non-round)
    // window timestamps involved — never a synthetic `index * stepSeconds` grid.
    expect(r.segments[0]!.endTime).not.toBe(20 * HOP + 15);
    expect(r.segments[1]!.startTime).not.toBe(20 * HOP);
  });

  it('holds on all 5 real annotated session fixtures', () => {
    const FIXTURE_DIR = nodePath.resolve(__dirname, '../../../test-fixtures/sessions');
    const REAL_FIXTURES = [
      'One_of_the_Best_Traditional_Irish_Music_Sessions_Longer_Video-windows.json',
      '20260523_5_auberge_fleurie-windows.json',
      '20260523_2_aprem_tabac-windows.json',
      '20260523_1_matin_Anglade-windows.json',
      '13th_Moon_Gravity_Well_-_Irish_Trad_Session_2024_01_24-windows.json',
    ];
    for (const file of REAL_FIXTURES) {
      const p = nodePath.join(FIXTURE_DIR, file);
      if (!fs.existsSync(p)) continue;
      const windows = JSON.parse(fs.readFileSync(p, 'utf-8')) as WindowResult[];
      const timeline = buildTemporalTimeline(windows, TEST_CFG);
      const r = runViterbiDetection(timeline, TEST_CFG);
      expectRawSpans(r.segments, windows);
    }
  }, 30000); // 4 real fixtures' full decode ~3s combined — comfortably under this, but tight against vitest's 5s default under any system load.
});

// ── filterShortSegments (2026-08-15 post-process) ───────────────────────────
// A deliberately SEPARATE step from the Viterbi decode (never called by
// runViterbiDetection itself) — see minSegmentWindows's doc in
// detectionTemporalConfig.ts. Built directly against hand-built
// DetectedTuneSegment literals (+ a matching synthetic TemporalTimeline for
// the rank data countTop1Windows reads) rather than through a full decode,
// since the point here is the post-process's own logic (relabel + merge),
// independent of whatever specific scores would make Viterbi produce a
// short segment.

function seg(tuneId: string, windowCount: number, startTime: number, endTime: number, firstWindowIndex = 0): DetectedTuneSegment {
  const unknown = tuneId === UNKNOWN_STATE;
  return {
    tuneId,
    displayName: unknown ? 'UNKNOWN' : `Tune ${tuneId}`,
    settingId: unknown ? '' : `s${tuneId}`,
    dance: unknown ? '' : 'reel',
    meter: unknown ? '' : '4/4',
    startTime,
    endTime,
    firstWindowIndex,
    confidence: unknown ? 0 : 0.9,
    averageProbability: unknown ? 0 : 0.9,
    minimumProbability: unknown ? 0 : 0.85,
    maximumProbability: unknown ? 0 : 0.95,
    windowCount,
  };
}

/** Builds a minimal TemporalTimeline whose `ranks` says every window in each
 *  given segment's range was that segment's tuneId at rank 1 — i.e. "the
 *  Viterbi-assigned windows and the rank-1 windows are the same set", which
 *  is what most of these tests want to hold constant so they can focus on
 *  the relabel/merge/exemption logic instead of the rank distinction
 *  (covered separately below). */
function allRank1Timeline(...segs: DetectedTuneSegment[]): TemporalTimeline {
  const ranks = new Map<string, (number | null)[]>();
  for (const s of segs) {
    if (s.tuneId === UNKNOWN_STATE) continue;
    const arr: (number | null)[] = ranks.get(s.tuneId) ?? [];
    for (let i = 0; i < s.windowCount; i++) arr[s.firstWindowIndex + i] = 1;
    ranks.set(s.tuneId, arr);
  }
  return { windows: [], tuneIds: [...ranks.keys()], meta: new Map(), observations: new Map(), ranks };
}

function summarize(segments: DetectedTuneSegment[]) {
  return segments.map(s => ({ tuneId: s.tuneId, windowCount: s.windowCount, startTime: s.startTime, endTime: s.endTime }));
}

describe('filterShortSegments', () => {
  it('relabels a non-last segment shorter than minWindowCount (rank-1 windows) as UNKNOWN, merging it with a neighbouring UNKNOWN segment', () => {
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 1, 25, 30, 5);
    const segments = [a, b, seg(UNKNOWN_STATE, 3, 30, 45, 6)];
    const result = filterShortSegments(segments, allRank1Timeline(a, b), 2, false);
    expect(summarize(result)).toEqual([
      { tuneId: 'A', windowCount: 5, startTime: 0, endTime: 25 },
      { tuneId: UNKNOWN_STATE, windowCount: 4, startTime: 25, endTime: 45 },
    ]);
    // The merged UNKNOWN segment's probability fields must still be exactly
    // zero (UNKNOWN's invariant everywhere else in this codebase), not an
    // average of the two sides' original (now-discarded) values.
    expect(result[1]!.confidence).toBe(0);
    expect(result[1]!.averageProbability).toBe(0);
    expect(result[1]!.minimumProbability).toBe(0);
    expect(result[1]!.maximumProbability).toBe(0);
  });

  it('merges two consecutive short segments (different tunes) that both get relabeled', () => {
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 1, 25, 30, 5);
    const c = seg('C', 1, 30, 35, 6);
    const d = seg('D', 5, 35, 60, 7);
    const result = filterShortSegments([a, b, c, d], allRank1Timeline(a, b, c, d), 2, false);
    expect(summarize(result)).toEqual([
      { tuneId: 'A', windowCount: 5, startTime: 0, endTime: 25 },
      { tuneId: UNKNOWN_STATE, windowCount: 2, startTime: 25, endTime: 35 },
      { tuneId: 'D', windowCount: 5, startTime: 35, endTime: 60 },
    ]);
  });

  it('exempts the last segment while exemptLastSegment=true (still live/streaming), even if short', () => {
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 1, 25, 30, 5);
    const live = filterShortSegments([a, b], allRank1Timeline(a, b), 2, true);
    expect(summarize(live)).toEqual([
      { tuneId: 'A', windowCount: 5, startTime: 0, endTime: 25 },
      { tuneId: 'B', windowCount: 1, startTime: 25, endTime: 30 },
    ]);
  });

  it('does NOT exempt the last segment once exemptLastSegment=false (finalized) — a genuinely short last segment is filtered too', () => {
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 1, 25, 30, 5);
    const finalized = filterShortSegments([a, b], allRank1Timeline(a, b), 2, false);
    expect(summarize(finalized)).toEqual([
      { tuneId: 'A', windowCount: 5, startTime: 0, endTime: 25 },
      { tuneId: UNKNOWN_STATE, windowCount: 1, startTime: 25, endTime: 30 },
    ]);
  });

  it('keeps a segment that exactly meets minWindowCount worth of rank-1 windows', () => {
    const a = seg('A', 2, 0, 10, 0);
    expect(summarize(filterShortSegments([a], allRank1Timeline(a), 2, false))).toEqual([
      { tuneId: 'A', windowCount: 2, startTime: 0, endTime: 10 },
    ]);
  });

  it('never touches a genuinely short UNKNOWN segment (already the "reject" state)', () => {
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 5, 30, 55, 6);
    const segments = [a, seg(UNKNOWN_STATE, 1, 25, 30, 5), b];
    expect(summarize(filterShortSegments(segments, allRank1Timeline(a, b), 2, false))).toEqual(summarize(segments));
  });

  it('rejects a segment Viterbi assigned enough windows to (windowCount >= threshold) but that was only ever the RAW top pick in fewer of them — the whole point of the 2026-08-15 change', () => {
    // B "wins" 3 windows (5,6,7) via Viterbi's transition-cost hysteresis,
    // but only window 6 ever had B as the engine's own #1 raw candidate —
    // windows 5 and 7 both had some OTHER tune ranked 1 there. Under the
    // old windowCount-only rule (3 >= 2) this would have been accepted;
    // under the rank-1 rule (1 < 2) it must be rejected.
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 3, 25, 40, 5);
    const ranks = new Map<string, (number | null)[]>([
      ['A', [1, 1, 1, 1, 1]],
      ['B', [null, null, null, null, null, 2, 1, 2]], // indices 5,6,7 -> rank 2, 1, 2
    ]);
    const timeline: TemporalTimeline = { windows: [], tuneIds: ['A', 'B'], meta: new Map(), observations: new Map(), ranks };
    const result = filterShortSegments([a, b], timeline, 2, false);
    expect(summarize(result)).toEqual([
      { tuneId: 'A', windowCount: 5, startTime: 0, endTime: 25 },
      { tuneId: UNKNOWN_STATE, windowCount: 3, startTime: 25, endTime: 40 },
    ]);
  });

  it('accepts a segment with fewer Viterbi-assigned windows than another as long as enough of ITS OWN windows were rank-1', () => {
    // Mirror case: B only gets 2 windows from Viterbi, but both were genuine
    // rank-1 raw picks — meets the threshold on its own merits.
    const a = seg('A', 5, 0, 25, 0);
    const b = seg('B', 2, 25, 35, 5);
    const ranks = new Map<string, (number | null)[]>([
      ['A', [1, 1, 1, 1, 1]],
      ['B', [null, null, null, null, null, 1, 1]],
    ]);
    const timeline: TemporalTimeline = { windows: [], tuneIds: ['A', 'B'], meta: new Map(), observations: new Map(), ranks };
    const result = filterShortSegments([a, b], timeline, 2, false);
    expect(summarize(result)).toEqual([
      { tuneId: 'A', windowCount: 5, startTime: 0, endTime: 25 },
      { tuneId: 'B', windowCount: 2, startTime: 25, endTime: 35 },
    ]);
  });
});

describe('countTop1Windows', () => {
  it('counts only windows where the tune is ranked exactly 1, ignoring other ranks and absences (null)', () => {
    const ranks = new Map<string, (number | null)[]>([['A', [1, 2, null, 1, 3, 1]]]);
    const timeline: TemporalTimeline = { windows: [], tuneIds: ['A'], meta: new Map(), observations: new Map(), ranks };
    expect(countTop1Windows('A', 0, 6, timeline)).toBe(3);
  });

  it('returns 0 for a tuneId with no rank data at all', () => {
    const timeline: TemporalTimeline = { windows: [], tuneIds: [], meta: new Map(), observations: new Map(), ranks: new Map() };
    expect(countTop1Windows('GHOST', 0, 5, timeline)).toBe(0);
  });

  it('only scans the given [firstIdx, firstIdx+windowCount) range', () => {
    const ranks = new Map<string, (number | null)[]>([['A', [1, 1, 1, 2, 2]]]);
    const timeline: TemporalTimeline = { windows: [], tuneIds: ['A'], meta: new Map(), observations: new Map(), ranks };
    expect(countTop1Windows('A', 3, 2, timeline)).toBe(0); // indices 3,4 are both rank 2
    expect(countTop1Windows('A', 0, 3, timeline)).toBe(3);
  });
});
