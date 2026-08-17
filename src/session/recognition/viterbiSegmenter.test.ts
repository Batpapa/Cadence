import { describe, it, expect } from 'vitest';
import { IncrementalViterbiSegmenter } from './viterbiSegmenter';
import { runViterbiDetection, filterShortSegments } from './viterbiDetector';
import { buildTemporalTimeline, UNKNOWN_STATE } from './temporalObservationBuilder';
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
  // 2 windows at HOP=5 — small on purpose so tests don't need long tails.
  finalizationLagSeconds: 10,
  minSegmentWindows: 2,
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
  const timeline = buildTemporalTimeline(windows, cfg);
  const result = runViterbiDetection(timeline, cfg);
  // Finalized batch context — exemptLastSegment=false, same as
  // IncrementalViterbiSegmenter.finalize() — so this stays a fair comparison
  // for the "matches a one-shot batch call" test below.
  return filterShortSegments(result.segments, timeline, cfg.minSegmentWindows, false).filter(s => s.tuneId !== UNKNOWN_STATE);
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

  it('finalizes only once finalizationLagSeconds has elapsed after the tune ends', () => {
    const seg = new IncrementalViterbiSegmenter(HOP, TEST_CFG);
    const store = new Map<string, SessionAnnotation>();
    // A plays windows 0-3, then goes silent long enough for UNKNOWN to take
    // over and for the lag horizon to clear.
    const windows = sequence([
      { A: 0.9 }, { A: 0.92 }, { A: 0.9 }, { A: 0.88 }, {}, {}, {}, {}, {}, {}, {}, {},
    ]);
    let lastFinalizedAtStep = -1;
    windows.forEach((w, i) => {
      apply(store, seg.step(w));
      const ann = [...store.values()].find(a => a.tuneId === 'A');
      if (ann?.finalized && lastFinalizedAtStep < 0) lastFinalizedAtStep = i;
    });

    expect(lastFinalizedAtStep).toBeGreaterThan(0);
    const ann = [...store.values()].find(a => a.tuneId === 'A')!;
    expect(ann.end).not.toBeNull();
    expect(ann.finalized).toBe(true);
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

  it('a clean back-to-back transition produces two annotations that OVERLAP by windowSeconds - stepSeconds — this must be preserved, never truncated to disjoint', () => {
    // 2026-08-15: a segment's start/end are the raw span of the observation
    // windows that produced it (15s wide, taken every 5s), not a claim about
    // exactly when the tune started/stopped — so a clean back-to-back
    // transition (no silent gap) legitimately produces two OVERLAPPING
    // annotations. An earlier same-day change wrongly forced these apart;
    // this guards against that regression at the annotation level (the
    // object the UI actually renders), not just at the raw segment level
    // (already covered in viterbiDetector.test.ts).
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
    expect(a.start).toBe(0);
    expect(a.end).toBe(30);  // windows[3].tWindowEnd
    expect(b.start).toBe(20); // windows[4].tWindowStart
    expect(b.end).toBe(50);  // windows[7].tWindowEnd
    expect(b.start).toBeLessThan(a.end!);
    expect(a.end! - b.start).toBe(10); // windowSeconds(15) - stepSeconds(5)
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
});
