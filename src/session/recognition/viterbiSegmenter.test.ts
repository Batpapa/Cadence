import { describe, it, expect } from 'vitest';
import { IncrementalViterbiSegmenter } from './viterbiSegmenter';
import { runViterbiDetection, filterShortSegments, mergeNearbySameTune } from './viterbiDetector';
import { buildTemporalTimeline, filterFlatWindows, filterByTempoSpread, UNKNOWN_STATE } from './temporalObservationBuilder';
import type { DetectionTemporalConfig } from './detectionTemporalConfig';
import type { WindowResult, WindowCandidate, SessionAnnotation, AnnotationEvent } from '../model';

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
  // 0 by default — disabled, so existing tests that happen to reuse a
  // tuneId letter aren't silently affected. Overridden explicitly in the
  // tests that exercise mergeNearbySameTune below.
  sameTuneMergeGapWindows: 0,
  // marginThreshold=0 disables the filter (gap is never negative, so
  // `gap >= 0` always holds) — same "off by default" reasoning as above.
  // Overridden explicitly in the tests that exercise filterFlatWindows below.
  flatWindowTopN: 3,
  flatWindowMarginThreshold: 0,
  // Same "disabled by default" reasoning — std dev is never negative, so
  // `std >= 0` always holds. Overridden explicitly in the tempo-filter wiring
  // test below.
  tempoSpreadThreshold: 0,
};

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * HOP;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

function sequence(rows: Record<string, number>[], startIdx = 0): WindowResult[] {
  return rows.map((row, i) => win(startIdx + i, Object.entries(row).map(([id, score]) => cand(id, score))));
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

/** Narrows out 'retract' (which carries no `.annotation`) for tests that only
 *  care about open/update/close events. */
function hasAnnotation(e: AnnotationEvent): e is Exclude<AnnotationEvent, { type: 'retract' }> {
  return e.type !== 'retract';
}

/** Mirrors liveSession.ts's/importSession.ts's applyEvents: last event per id
 *  wins, 'retract' deletes (unless the user already confirmed it). */
function apply(store: Map<string, SessionAnnotation>, events: AnnotationEvent[]): void {
  for (const ev of events) {
    if (ev.type === 'retract') {
      if (!store.get(ev.id)?.userConfirmed) store.delete(ev.id);
      continue;
    }
    store.set(ev.annotation.id, ev.annotation);
  }
}

function batchSegments(windows: WindowResult[], cfg: DetectionTemporalConfig = TEST_CFG) {
  const marginFiltered = filterFlatWindows(windows, cfg.flatWindowTopN, cfg.flatWindowMarginThreshold);
  const detectionWindows = filterByTempoSpread(marginFiltered, cfg.tempoSpreadThreshold);
  const timeline = buildTemporalTimeline(detectionWindows, cfg);
  const result = runViterbiDetection(timeline, cfg);
  // Finalized batch context — exemptLastSegment=false, same as
  // IncrementalViterbiSegmenter.finalize() — so this stays a fair comparison
  // for the "matches a one-shot batch call" test below.
  const filtered = filterShortSegments(result.segments, timeline, cfg.minSegmentWindows, false);
  const merged = mergeNearbySameTune(filtered, timeline, cfg.sameTuneMergeGapWindows);
  return merged.filter(s => s.tuneId !== UNKNOWN_STATE);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IncrementalViterbiSegmenter', () => {
  it('a segment stays unfinalized (and open-ended) while actively playing', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([{ A: 0.9 }, { A: 0.92 }, { A: 0.9 }]);
    for (const w of windows) apply(store, seg.step(w));

    const anns = [...store.values()];
    expect(anns).toHaveLength(1);
    expect(anns[0]!.tuneId).toBe('A');
    expect(anns[0]!.finalized).toBe(false);
    expect(anns[0]!.end).toBeNull(); // still "playing" as far as we know
  });

  it('viterbiPick mirrors the winning segment\'s own identity, and alternates carry dance/meter — the "explore alternatives" picker (2026-08-25) needs both', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    // B loses every window (lower score) but still shows up as a real
    // candidate throughout A's span — exactly the shape computeAlternates
    // ranks by mean score.
    const windows = sequence([{ A: 0.9, B: 0.3 }, { A: 0.92, B: 0.35 }, { A: 0.9, B: 0.32 }]);
    for (const w of windows) apply(store, seg.step(w));

    const ann = [...store.values()].find(a => a.tuneId === 'A')!;
    expect(ann.viterbiPick).toEqual({
      tuneId: 'A', settingId: 'sA', displayName: 'Tune A', dance: 'reel', meter: '4/4', meanScore: ann.meanScore,
    });
    expect(ann.alternates).toHaveLength(1);
    expect(ann.alternates[0]).toMatchObject({ tuneId: 'B', settingId: 'sB', displayName: 'Tune B', dance: 'reel', meter: '4/4' });
    expect(ann.alternates[0]!.meanScore).toBeCloseTo((0.3 + 0.35 + 0.32) / 3, 6);
  });

  it('alternates\' meanScore is averaged over EVERY window in the span (zero-filled where absent), not just the windows the tune happened to appear in — regression (2026-08-25, reported by the user eyeballing an implausibly high alternate)', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    // A wins all 4 windows. B is only ever a candidate in ONE of them (a
    // brief spike, score 0.8) — absent (not even a weak candidate) the other
    // 3. A sparse average (old, buggy behavior) would report B at 0.8 (as if
    // consistently strong); the correct dense average must treat the 3
    // absent windows as 0 and report 0.8/4 = 0.2.
    const windows = sequence([{ A: 0.9 }, { A: 0.92, B: 0.8 }, { A: 0.9 }, { A: 0.88 }]);
    for (const w of windows) apply(store, seg.step(w));

    const ann = [...store.values()].find(a => a.tuneId === 'A')!;
    const b = ann.alternates.find(a => a.tuneId === 'B')!;
    expect(b).toBeDefined();
    expect(b.meanScore).toBeCloseTo(0.8 / 4, 6);
    expect(b.meanScore).not.toBeCloseTo(0.8, 6); // the sparse-average bug's answer
  });

  it('finalizes as soon as the Viterbi decode provably converges — not after a fixed time lag (2026-08-21, replaces the old finalizationLagSeconds heuristic)', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG); // sameTuneMergeGapWindows: 0
    const store = new Map<string, SessionAnnotation>();
    // A plays windows 0-3, then goes silent. Not finalized right when A's
    // last real window lands (window 3 alone still leaves open "maybe this
    // drops back to A next window" — no future evidence ruling that out
    // yet). One single UNKNOWN window (index 4) is already enough for every
    // possible current state's own backtrack path to agree windows 0-3 were
    // A — see findConvergencePoint's doc — so finalization fires immediately
    // then, not after padding out a fixed lag.
    const windows = sequence([{ A: 0.9 }, { A: 0.92 }, { A: 0.9 }, { A: 0.88 }, {}]);
    const finalizedAt = windows.map(w => {
      apply(store, seg.step(w));
      return [...store.values()].find(a => a.tuneId === 'A')?.finalized ?? false;
    });

    expect(finalizedAt).toEqual([false, false, false, false, true]);
    const ann = [...store.values()].find(a => a.tuneId === 'A')!;
    expect(ann.end).toBe(25); // midway between centre(3)=22.5 and centre(4)=27.5
  });

  it('finalization also waits out sameTuneMergeGapWindows past the segment — a same-tune neighbour could still merge in from later, even once the raw Viterbi path itself has converged', () => {
    const cfg = { ...TEST_CFG, sameTuneMergeGapWindows: 3 };
    const seg = new IncrementalViterbiSegmenter(HOP, cfg);
    const store = new Map<string, SessionAnnotation>();
    // Same shape as above (raw path converges at step 4), but now a same-tune
    // reappearance up to 3 windows later could still retroactively merge into
    // this segment — finality must wait for that margin to clear too, not
    // just for Viterbi's own state assignment to settle.
    const windows = sequence([
      { A: 0.9 }, { A: 0.92 }, { A: 0.9 }, { A: 0.88 }, {}, {}, {}, {},
    ]);
    const finalizedAt = windows.map(w => {
      apply(store, seg.step(w));
      return [...store.values()].find(a => a.tuneId === 'A')?.finalized ?? false;
    });

    expect(finalizedAt).toEqual([false, false, false, false, false, false, false, true]);
  });

  it('a superseded segment stops showing end:null ("playing…") the moment it is no longer the live tail, even though it is not finalized yet — regression (2026-08-24): the "nothing worth telling the UI about" shortcut only compared the segment\'s OWN fields (tuneId/bounds/confidence), which can legitimately stay identical across the very recompute where a LATER segment takes over the tail, silently swallowing the open->closed transition and leaving the annotation stuck at end:null indefinitely', () => {
    const cfg = { ...TEST_CFG, sameTuneMergeGapWindows: 3 };
    const seg = new IncrementalViterbiSegmenter(HOP, cfg);
    const store = new Map<string, SessionAnnotation>();
    // Same shape as the sibling "waits out sameTuneMergeGapWindows" test
    // above: A's raw Viterbi assignment converges at step 4, but with
    // sameTuneMergeGapWindows=3, finalization itself doesn't land until step
    // 7 — so there are several steps in between where A is genuinely no
    // longer the tail (window 4 onward decodes UNKNOWN) but still
    // unfinalized, exactly the "pending confirmation" state the UI shows an
    // hourglass for. A's own segment bounds (windows 0-3) never change again
    // after step 3, which is precisely what let the bug hide.
    const windows = sequence([
      { A: 0.9 }, { A: 0.92 }, { A: 0.9 }, { A: 0.88 }, {}, {}, {}, {},
    ]);
    const endAt = windows.map(w => {
      apply(store, seg.step(w));
      const ann = [...store.values()].find(a => a.tuneId === 'A');
      return ann ? ann.end : 'MISSING';
    });

    // Once it exists, it reads end:null ("playing…") while still the live tail.
    expect(endAt[3]).toBeNull();
    // The moment window 4 (first silent one) supersedes it, end must become
    // real RIGHT THEN — not stay null for steps 4-6 while only `finalized`
    // eventually flips at step 7 (already covered by the sibling test).
    expect(endAt.slice(4)).toEqual([25, 25, 25, 25]); // midway between centres of windows 3 and 4
  });

  it('produces the same net segments as a one-shot batch runViterbiDetection() call once fully finalized', () => {
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.85 }, { A: 0.4 }, { A: 0.1 },
      { B: 0.05 }, { B: 0.1 }, { B: 0.9 }, { B: 0.92 }, { B: 0.9 }, { B: 0.91 },
    ]);

    const batch = batchSegments(windows);

    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    for (const w of windows) apply(store, seg.step(w));
    apply(store, seg.finalize());

    const incremental = [...store.values()].sort((a, b) => a.start - b.start);
    expect(incremental.every(a => a.finalized)).toBe(true);
    expect(incremental.map(a => ({ tuneId: a.tuneId, start: a.start, end: a.end }))).toEqual(
      batch.map(s => ({ tuneId: s.tuneId, start: s.startTime, end: s.endTime })),
    );
  });

  it('finalize() forces every remaining segment final, even one still actively playing', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([{ A: 0.9 }, { A: 0.92 }, { A: 0.9 }]);
    for (const w of windows) apply(store, seg.step(w));
    apply(store, seg.finalize());

    const ann = [...store.values()][0]!;
    expect(ann.finalized).toBe(true);
    expect(ann.end).not.toBeNull();
  });

  it('does not resurrect a segment already finalized once new unrelated windows keep arriving', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    const events1: AnnotationEvent[] = [];
    const windows = sequence([
      { A: 0.9 }, { A: 0.92 }, { A: 0.9 }, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
    ]);
    windows.forEach(w => events1.push(...seg.step(w)));
    apply(store, events1);
    const finalizedEventCount = events1.filter(hasAnnotation).filter(e => e.annotation.tuneId === 'A' && e.annotation.finalized).length;
    expect(finalizedEventCount).toBeGreaterThan(0);

    // Feed 10 more empty windows — A is long finalized, should stay silent (no more events for it).
    const more = sequence(Array.from({ length: 10 }, () => ({})), windows.length);
    const events2: AnnotationEvent[] = [];
    more.forEach(w => events2.push(...seg.step(w)));
    expect(events2.filter(hasAnnotation).filter(e => e.annotation.tuneId === 'A')).toHaveLength(0);
  });

  it('never emits an annotation for UNKNOWN_STATE (silence/talk/noise)', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const events: AnnotationEvent[] = [];
    const windows = sequence([{}, {}, {}, {}, {}, {}]);
    windows.forEach(w => events.push(...seg.step(w)));
    events.push(...seg.finalize());
    expect(events.filter(hasAnnotation).every(e => e.annotation.tuneId !== UNKNOWN_STATE)).toBe(true);
    expect(events).toHaveLength(0);
  });

  it('a clean back-to-back transition produces two annotations that ABUT exactly — no overlap, no gap', () => {
    // 2026-09-01: an annotation's start/end are the ESTIMATED boundaries, each
    // placed midway between the centres of the two windows straddling it — so a
    // clean back-to-back transition (no silent gap) produces two annotations
    // that meet at one instant. Until this date they overlapped by
    // windowSeconds - stepSeconds, which measured 5s early against ground
    // truth; see windowRangeToTime. Guarded here at the ANNOTATION level (the
    // object the UI renders), not just at the raw segment level (already
    // covered in viterbiDetector.test.ts).
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 },
      { B: 0.93 }, { B: 0.9 }, { B: 0.92 }, { B: 0.91 },
    ]);
    for (const w of windows) apply(store, seg.step(w));
    apply(store, seg.finalize());

    const anns = [...store.values()].sort((a, b) => a.start - b.start);
    expect(anns.map(a => a.tuneId)).toEqual(['A', 'B']);
    const [a, b] = anns as [SessionAnnotation, SessionAnnotation];
    // windows[k] spans [5k, 5k+15], so centre(k) = 5k + 7.5.
    expect(a.start).toBe(0);   // recording edge
    expect(a.end).toBe(25);    // (centre(3) + centre(4)) / 2 = (22.5 + 27.5) / 2
    expect(b.start).toBe(25);  // the same instant
    expect(b.end).toBe(50);    // recording edge = windows[7].tWindowEnd
    expect(b.start).toBe(a.end!);
  });

  it('minSegmentWindows: a short segment IS shown while it is the live tail, but is RETRACTED (removed entirely) once superseded without ever reaching the threshold', () => {
    // 2026-08-15: user explicitly wants the live tail exempt from
    // minSegmentWindows — a single-window Viterbi guess is allowed to open
    // as a real annotation while it's the most recent thing seen so far
    // ("j'accepte de l'afficher"). But once superseded without ever reaching
    // the threshold, a `close` (even with finalized:false) still left a
    // permanent, if unconfirmed, stub sitting in the final list — not
    // acceptable per the user's explicit follow-up ("ils devraient être
    // rejetés et disparaître... ils sont toujours présents dans l'UI"). It
    // must be retracted — removed from the annotation map entirely, as if it
    // had never been shown — matching the real-world pattern reported
    // against a real recording (a chain of different single-window guesses).
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG); // minSegmentWindows: 2
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 }, // A: 5 windows, safely above the floor
      { B: 0.9 },                                                     // B: a single stray window
      { C: 0.92 }, { C: 0.95 }, { C: 0.94 }, { C: 0.91 }, { C: 0.93 }, // C: 5 windows, safely above the floor
    ]);

    for (let i = 0; i < 6; i++) apply(store, seg.step(windows[i]!)); // through B's own window
    // B is the live tail — shown even though it's only 1 window long so far.
    const bWhileLive = [...store.values()].find(a => a.tuneId === 'B');
    expect(bWhileLive).toBeDefined();
    expect(bWhileLive!.finalized).toBe(false);

    for (let i = 6; i < windows.length; i++) apply(store, seg.step(windows[i]!)); // C arrives, supersedes B
    // B is no longer the tail and never reached minSegmentWindows — it must
    // be GONE from the store entirely, not just closed/unfinalized.
    expect([...store.values()].some(a => a.tuneId === 'B')).toBe(false);

    apply(store, seg.finalize());
    const anns = [...store.values()].sort((a, b) => a.start - b.start);
    expect(anns.map(a => a.tuneId)).toEqual(['A', 'C']);
    expect(anns.every(a => a.finalized)).toBe(true);
  });

  it('minSegmentWindows: never retracts an annotation the caller has already marked userConfirmed', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 },
      { B: 0.9 },
      { C: 0.92 }, { C: 0.95 }, { C: 0.94 }, { C: 0.91 }, { C: 0.93 },
    ]);

    for (let i = 0; i < 6; i++) apply(store, seg.step(windows[i]!));
    const b = [...store.values()].find(a => a.tuneId === 'B')!;
    store.set(b.id, { ...b, userConfirmed: true }); // user manually confirms B while it's still just 1 window

    for (let i = 6; i < windows.length; i++) apply(store, seg.step(windows[i]!));
    // The segmenter still emits 'retract' for B (it has no notion of
    // userConfirmed) — the orchestrator-level guard is what must hold here.
    const bAfter = [...store.values()].find(a => a.tuneId === 'B');
    expect(bAfter).toBeDefined();
    expect(bAfter!.userConfirmed).toBe(true);
  });

  it('mergeNearbySameTune: bridges a brief UNKNOWN gap between two occurrences of the SAME tune into one continuous annotation', () => {
    const cfg = { ...TEST_CFG, sameTuneMergeGapWindows: 10 };
    const seg = new IncrementalViterbiSegmenter(HOP, cfg);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 }, // A: 5 windows
      {}, {}, {},                                                     // gap: 3 empty windows (< 10) -> UNKNOWN
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 },                          // A again: 3 windows
    ]);
    for (const w of windows) apply(store, seg.step(w));
    apply(store, seg.finalize());

    const anns = [...store.values()];
    expect(anns).toHaveLength(1);
    expect(anns[0]!.tuneId).toBe('A');
    expect(anns[0]!.start).toBe(0);
    expect(anns[0]!.end).toBe(windows[windows.length - 1]!.tWindowEnd);
    expect(anns[0]!.finalized).toBe(true);
  });

  it('mergeNearbySameTune: does NOT bridge a gap of >= sameTuneMergeGapWindows — stays two separate detections', () => {
    const cfg = { ...TEST_CFG, sameTuneMergeGapWindows: 3 };
    const seg = new IncrementalViterbiSegmenter(HOP, cfg);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 },
      {}, {}, {}, {}, // gap: 4 empty windows (>= 3) -> should NOT merge
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 },
    ]);
    for (const w of windows) apply(store, seg.step(w));
    apply(store, seg.finalize());

    const anns = [...store.values()].sort((a, b) => a.start - b.start);
    expect(anns.map(a => a.tuneId)).toEqual(['A', 'A']);
  });

  it('mergeNearbySameTune: never merges across a DIFFERENT confirmed tune in between (A, B, A stays three results)', () => {
    const cfg = { ...TEST_CFG, sameTuneMergeGapWindows: 10 };
    const seg = new IncrementalViterbiSegmenter(HOP, cfg);
    const store = new Map<string, SessionAnnotation>();
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 },
      { B: 0.92 }, { B: 0.95 }, { B: 0.94 }, { B: 0.91 }, { B: 0.93 },
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 },
    ]);
    for (const w of windows) apply(store, seg.step(w));
    apply(store, seg.finalize());

    const anns = [...store.values()].sort((a, b) => a.start - b.start);
    expect(anns.map(a => a.tuneId)).toEqual(['A', 'B', 'A']);
  });

  it('filterFlatWindows wiring: a real flatWindowMarginThreshold changes detection vs the disabled (0) default', () => {
    // A always ranks 1st, but by a razor-thin margin over B every window —
    // exactly the "flat" case flatWindowTopN/flatWindowMarginThreshold exist
    // to strip before Viterbi ever sees it (see detectionTemporalConfig.ts).
    const windows = sequence([
      { A: 0.92, B: 0.90 }, { A: 0.93, B: 0.91 }, { A: 0.91, B: 0.89 },
      { A: 0.92, B: 0.90 }, { A: 0.93, B: 0.91 },
    ]);

    const withoutFilter = new IncrementalViterbiSegmenter(HOP, { ...TEST_CFG, flatWindowMarginThreshold: 0 });
    const storeWithout = new Map<string, SessionAnnotation>();
    for (const w of windows) apply(storeWithout, withoutFilter.step(w));
    apply(storeWithout, withoutFilter.finalize());
    expect([...storeWithout.values()].map(a => a.tuneId)).toEqual(['A']);

    const withFilter = new IncrementalViterbiSegmenter(HOP, { ...TEST_CFG, flatWindowTopN: 2, flatWindowMarginThreshold: 0.05 });
    const storeWith = new Map<string, SessionAnnotation>();
    for (const w of windows) apply(storeWith, withFilter.step(w));
    apply(storeWith, withFilter.finalize());
    expect([...storeWith.values()]).toHaveLength(0);
  });

  it('filterByTempoSpread wiring: a real tempoSpreadThreshold changes detection vs the disabled (0) default', () => {
    // A wins clearly every window (margin filter has nothing to do here —
    // TEST_CFG's flatWindowMarginThreshold stays 0/disabled), but its
    // tempo-candidate spread is razor-thin ("tempo-agnostic") every window —
    // exactly the case tempoSpreadThreshold exists to strip before Viterbi
    // ever sees it (see detectionTemporalConfig.ts).
    const flatTempo = [0.40, 0.41, 0.39, 0.40, 0.41];
    const windows = [
      winWithTempo(0, [cand('A', 0.92)], flatTempo),
      winWithTempo(1, [cand('A', 0.93)], flatTempo),
      winWithTempo(2, [cand('A', 0.91)], flatTempo),
      winWithTempo(3, [cand('A', 0.92)], flatTempo),
      winWithTempo(4, [cand('A', 0.93)], flatTempo),
    ];

    const withoutFilter = new IncrementalViterbiSegmenter(HOP, { ...TEST_CFG, tempoSpreadThreshold: 0 });
    const storeWithout = new Map<string, SessionAnnotation>();
    for (const w of windows) apply(storeWithout, withoutFilter.step(w));
    apply(storeWithout, withoutFilter.finalize());
    expect([...storeWithout.values()].map(a => a.tuneId)).toEqual(['A']);

    const withFilter = new IncrementalViterbiSegmenter(HOP, { ...TEST_CFG, tempoSpreadThreshold: 0.10 });
    const storeWith = new Map<string, SessionAnnotation>();
    for (const w of windows) apply(storeWith, withFilter.step(w));
    apply(storeWith, withFilter.finalize());
    expect([...storeWith.values()]).toHaveLength(0);
  });
});
