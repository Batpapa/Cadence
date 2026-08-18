import { describe, it, expect } from 'vitest';
import { recomputeAnnotations } from './recovery';
import { ANALYSIS_HOP_S } from './sessionConfig';
import type { WindowResult, WindowCandidate } from './model';

// ── recomputeAnnotations (crash recovery, 2026-08-15) ───────────────────────
// Reproduces the exact scenario that motivated ditching the old
// "blanket-finalize the persisted annotation snapshot" recovery strategy: a
// crash landing right after a short-lived, never-confirmed guess was
// live-shown (see minSegmentWindows/'retract' in viterbiSegmenter.ts) must
// NOT resurrect that guess as a real, finalized detection just because it
// happened to be in IndexedDB at the moment of the crash. Replaying the raw
// windows through a fresh detector is the whole point: the result must be
// identical to what a clean stop() would have produced from the same
// windows, `retract`s included.

function cand(tuneId: string, score: number): WindowCandidate {
  return { tuneId, settingId: `s${tuneId}`, displayName: `Tune ${tuneId}`, dance: 'reel', meter: '4/4', score };
}

function win(i: number, candidates: WindowCandidate[]): WindowResult {
  const t = i * ANALYSIS_HOP_S;
  return { tWindowStart: t, tWindowEnd: t + 15, empty: candidates.length === 0, candidates };
}

function sequence(rows: Record<string, number>[]): WindowResult[] {
  return rows.map((row, i) => win(i, Object.entries(row).map(([id, score]) => cand(id, score))));
}

describe('recomputeAnnotations', () => {
  it('never resurrects a short-lived, never-confirmed guess that happened to be the live tail at the moment of a "crash"', () => {
    // A plays a real, sustained run; B is a single stray window that was the
    // live tail right when the recording was cut off (the crash) — exactly
    // the scenario that used to leak a permanent, finalized "B" annotation
    // through the old blanket-finalize recovery path.
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 },
      { B: 0.9 }, // <- "crash" happens right here, B is the current live tail
    ]);

    const annotations = recomputeAnnotations(windows);
    expect(annotations.map(a => a.tuneId)).toEqual(['A']);
    expect(annotations.every(a => a.finalized)).toBe(true);
  });

  it('keeps a genuine detection that had already reached minSegmentWindows before the crash', () => {
    const windows = sequence([
      { A: 0.92 }, { A: 0.95 }, { A: 0.94 }, { A: 0.91 }, { A: 0.93 },
      { B: 0.9 }, { B: 0.92 }, // B reached the threshold before the "crash"
    ]);

    const annotations = recomputeAnnotations(windows);
    expect(annotations.map(a => a.tuneId)).toEqual(['A', 'B']);
    expect(annotations.every(a => a.finalized)).toBe(true);
  });

  it('returns an empty list for an empty windows array (crash before the first analysis)', () => {
    expect(recomputeAnnotations([])).toEqual([]);
  });

  it('stays fast for a long orphaned session (regression guard, 2026-08-18) — replaying via feedAll() must not regress to a per-window step() loop (O(T²), took minutes/hung on a real multi-hour session — see viterbiSegmenter.ts)', () => {
    const rows: Record<string, number>[] = [];
    for (let i = 0; i < 1000; i++) rows.push({ A: 0.9 + (i % 3) * 0.01 });
    const windows = sequence(rows);

    const start = performance.now();
    const annotations = recomputeAnnotations(windows);
    const elapsed = performance.now() - start;

    expect(annotations.map(a => a.tuneId)).toEqual(['A']);
    expect(elapsed).toBeLessThan(2000);
  });
});
