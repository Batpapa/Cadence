import { describe, it, expect } from 'vitest';
import { passGeometry, suggestedEnd, suggestedStart, joinedBound, fixSeam, alignedBounds, withinReach, suggestionsIn, alignmentPlan } from './boundSuggest';

/** An alignment of a 16-quaver tune, a quaver every 0.25 s (a 4 s pass):
 *  `count` quavers from score index `first`, the first at `t0`. */
function played(first: number, count: number, t0 = 10, match = 0.7) {
  const times: number[] = [], indices: number[] = [];
  for (let k = 0; k < count; k++) { times.push(t0 + k * 0.25); indices.push((first + k) % 16); }
  return { times, indices, end: t0 + count * 0.25, quavers: 16, match };
}

describe('the passes of an alignment', () => {
  it('finds where each pass begins, and how long one lasts', () => {
    const g = passGeometry(played(0, 48), 100)!;
    expect(g.pass).toBeCloseTo(4);
    expect(g.headFrac).toBe(0);
    expect(g.tailFrac).toBe(0);
    // The start, the two returns to the top, the end of the third pass.
    expect(g.marks).toEqual([
      { t: 110, pass: 1 }, { t: 114, pass: 2 }, { t: 118, pass: 3 }, { t: 122, pass: 3, end: true },
    ]);
  });

  it('numbers the passes as the Synchro audio does', () => {
    // Begun mid-pass: that partial pass is the first, the return the second.
    expect(passGeometry(played(10, 30), 0)!.marks[0]).toEqual({ t: 11.5, pass: 2 });
    // Begun on a pickup: the return to the top begins the first.
    expect(passGeometry({ ...played(15, 33), pickup: 1 }, 0)!.marks[0]).toEqual({ t: 10.25, pass: 1 });
  });

  it('says nothing from a handful of quavers', () => {
    expect(passGeometry(played(0, 5), 0)).toBeNull();
  });
});

describe('the bounds the passes suggest', () => {
  it('finishes a pass played past 80 %', () => {
    // Three passes and 14 quavers of the fourth: two more to its end.
    const g = passGeometry(played(0, 62), 0)!;
    expect(suggestedEnd(g)).toBeCloseTo(10 + 64 * 0.25);
  });

  it('drops a pass barely begun', () => {
    // One quaver into the fourth pass: the next tune's first note, most likely.
    const g = passGeometry(played(0, 49), 0)!;
    expect(suggestedEnd(g)).toBeCloseTo(10 + 48 * 0.25);
  });

  it('proposes nothing where the alignment stops mid-pass', () => {
    expect(suggestedEnd(passGeometry(played(0, 56), 0)!)).toBeNull();
  });

  it('brings a start missing its first note back to the pass', () => {
    const g = passGeometry(played(1, 47), 0)!;
    expect(suggestedStart(g)).toBeCloseTo(10 - 0.25);
  });

  it('moves a start on past the last notes of a pass', () => {
    // Begun on the score's last quaver: the tune before's last note, or a pickup.
    const g = passGeometry(played(15, 49), 0)!;
    expect(suggestedStart(g)).toBeCloseTo(10.25);
  });

  it('tolerates as much missing, and as much spilt, at either bound', () => {
    // Three quavers of 16 missing (under P_MISSTAIL): at the start as at the end.
    expect(suggestedStart(passGeometry(played(3, 45), 0)!)).toBeCloseTo(10 - 0.75);
    expect(suggestedEnd(passGeometry(played(0, 61), 0)!)).toBeCloseTo(10 + 64 * 0.25);
    // Two quavers spilt into the next pass, or from the one before (under P_OVERSHOOT).
    expect(suggestedEnd(passGeometry(played(0, 50), 0)!)).toBeCloseTo(10 + 48 * 0.25);
    expect(suggestedStart(passGeometry(played(14, 50), 0)!)).toBeCloseTo(10.5);
    // Four missing, or three spilt: mid-pass, nothing.
    expect(suggestedStart(passGeometry(played(4, 44), 0)!)).toBeNull();
    expect(suggestedEnd(passGeometry(played(0, 51), 0)!)).toBeNull();
  });

  it('proposes nothing from an alignment no better than a wrong score', () => {
    const g = passGeometry(played(0, 62, 10, 0.45), 0)!;
    expect(suggestedEnd(g)).toBeNull();
    expect(suggestedStart(g)).toBeNull();
  });
});

describe('a join', () => {
  it('takes two suggestions within a second halfway', () => {
    expect(joinedBound(100.2, 100.8)).toBeCloseTo(100.5);
    expect(joinedBound(100, 101.5)).toBeNull();
    expect(joinedBound(null, 100)).toBeNull();
  });

  const a = { start: 0, end: 95 }, b = { start: 105, end: 200 };

  it('joins a hole when both sides agree', () => {
    expect(fixSeam(a, b, 100.4, 100)).toEqual({ kind: 'joined', t: 100.2, gap: expect.closeTo(0.4) });
  });

  it('moves each side of a hole on its own when they disagree without crossing', () => {
    expect(fixSeam(a, b, 97, 103)).toEqual({ kind: 'apart', end: 97, start: 103 });
    expect(fixSeam(a, b, 97, null)).toEqual({ kind: 'apart', end: 97, start: null });
  });

  it('does not make an overlap of a hole', () => {
    expect(fixSeam(a, b, 104, 99)).toEqual({ kind: 'disagree', gap: 5 });
    expect(fixSeam(a, b, 106, null)).toEqual({ kind: 'disagree', gap: null });
  });

  it('moves two touching tunes together or not at all', () => {
    const touching = { start: 95, end: 200 };
    expect(fixSeam(a, touching, 96, null)).toEqual({ kind: 'disagree', gap: null });
    expect(fixSeam(a, touching, 96, 98)).toEqual({ kind: 'disagree', gap: 2 });
    expect(fixSeam(a, touching, 96, 96.6)).toEqual({ kind: 'joined', t: 96.3, gap: expect.closeTo(0.6) });
  });

  it('ignores a suggestion that would turn its own tune inside out', () => {
    expect(fixSeam({ start: 0, end: 10 }, b, 0.5, null)).toEqual({ kind: 'none' });
  });
});

describe('every bound of an analysis at once', () => {
  const s = (start: number | null, end: number | null) => ({ start, end });

  it('joins two tunes of a set and settles both ends of the recording', () => {
    const out = alignedBounds([
      { id: 'a', start: 10, end: 95, suggestion: s(8, 100.4) },
      { id: 'b', start: 105, end: 200, suggestion: s(100, 203) },
    ], true);
    expect(out.get('a')).toEqual({ start: 8, end: expect.closeTo(100.2) });
    expect(out.get('b')).toEqual({ start: expect.closeTo(100.2), end: 203 });
  });

  it('leaves the last end alone while more may follow', () => {
    const out = alignedBounds([{ id: 'a', start: 10, end: 95, suggestion: s(null, 100) }], false);
    expect(out.size).toBe(0);
  });

  it('moves nothing that has no answer yet, and joins a silence as any join', () => {
    const out = alignedBounds([
      { id: 'a', start: 0, end: 90, suggestion: s(null, 100.3) },
      { id: 'b', start: 120, end: 200, suggestion: s(100, null) },
      { id: 'c', start: 205, end: 300 },
    ], true);
    expect(out.get('a')!.end).toBeCloseTo(100.15);
    expect(out.get('b')!.start).toBeCloseTo(100.15);
    expect(out.has('c')).toBe(false);
  });

  it('joins with the tune reaching furthest, not the last to start', () => {
    const out = alignedBounds([
      { id: 'a', start: 0, end: 200, suggestion: s(null, 210.5) },
      { id: 'b', start: 20, end: 40 },
      { id: 'c', start: 215, end: 300, suggestion: s(210, null) },
    ], true);
    expect(out.get('a')!.end).toBeCloseTo(210.25);
    expect(out.get('c')!.start).toBeCloseTo(210.25);
  });
});

describe('a suggestion too far from the recogniser', () => {
  it('is not one', () => {
    expect(withinReach(122, 100)).toBe(122);
    expect(withinReach(27, 100)).toBeNull();
    expect(withinReach(null, 100)).toBeNull();
  });
});

describe('the edges of the recording', () => {
  it('puts a start on the recording’s own where it began mid-pass', () => {
    // From the 15th quaver of 16, at 0.2 s: the tune was already playing.
    const g = passGeometry(played(14, 40, 0.2), 0)!;
    expect(suggestedStart(g)).toBeCloseTo(0.2 + 0.5);
    expect(suggestionsIn(g, 0, 600).start).toBe(0);
  });

  it('puts an end on the recording’s own where it stopped, never past it', () => {
    const g = passGeometry(played(0, 49), 0)!;
    expect(suggestionsIn(g, 0, 22.3).end).toBe(22.3);
    const h = passGeometry(played(0, 62), 0)!;
    expect(suggestionsIn(h, 0, 600).end).toBeCloseTo(26);
    // Still being recorded: no end to run into.
    expect(suggestionsIn(g, 0, null).end).toBeCloseTo(22);
  });

  it('proposes nothing at an edge from an alignment no better than a wrong score', () => {
    const g = passGeometry(played(13, 40, 0.2, 0.45), 0)!;
    expect(suggestionsIn(g, 0, 600)).toEqual({ start: null, end: null, why: { start: 'unsure', end: 'unsure' } });
  });
});

describe('what is aligned for a detection', () => {
  it('is its stretch with margins, an edge where the recording starts', () => {
    expect(alignmentPlan(10, 100, 600)).toEqual([{ from: 0, to: 115, lo: 0, hi: null, bounds: 'both' }]);
    expect(alignmentPlan(50, 100, 110)).toEqual([{ from: 35, to: 110, lo: null, hi: 110, bounds: 'both' }]);
    // Still being recorded: no end to run into.
    expect(alignmentPlan(50, 100, Infinity)).toEqual([{ from: 35, to: 115, lo: null, hi: null, bounds: 'both' }]);
  });

  it('stops at a pause on either side, which is an edge', () => {
    expect(alignmentPlan(50, 100, 600, [40, 108])).toEqual([{ from: 40, to: 108, lo: 40, hi: 108, bounds: 'both' }]);
    // A pause within EDGE_S of a bound is that bound's.
    expect(alignmentPlan(50, 100, 600, [51])).toEqual([{ from: 51, to: 115, lo: 51, hi: null, bounds: 'both' }]);
  });

  it('aligns a detection over a pause twice, never across it', () => {
    expect(alignmentPlan(50, 200, 600, [120, 150])).toEqual([
      { from: 35, to: 120, lo: null, hi: 120, bounds: 'start' },
      { from: 150, to: 215, lo: 150, hi: null, bounds: 'end' },
    ]);
  });
});

describe('a pause as an edge', () => {
  it('ends a tune cut by the pause at it, and starts one resumed mid-pass at it', () => {
    // Cut at 60 % of a pass, at 20 s: the pause is the end.
    const cut = passGeometry(played(0, 42, 10), 0)!;
    expect(suggestionsIn(cut, null, 20.6).end).toBe(20.6);
    // Resumed at 300 s, 85 % into a pass: the pause is the start.
    const resumed = passGeometry(played(13, 40, 300.3), 0)!;
    expect(suggestionsIn(resumed, 300, null).start).toBe(300);
  });
});

describe('a pause near a bound', () => {
  it('belongs to the bound it is nearest, a window hop or two off', () => {
    // The recogniser's end 5 s past the pause that cut the tune.
    expect(alignmentPlan(50, 205, 600, [200])).toEqual([{ from: 35, to: 200, lo: null, hi: 200, bounds: 'both' }]);
    // A start 5 s before the resume.
    expect(alignmentPlan(195, 300, 600, [200])).toEqual([{ from: 200, to: 315, lo: 200, hi: null, bounds: 'both' }]);
    // A short detection: the pause goes to the nearer bound only.
    expect(alignmentPlan(100, 115, 600, [104])).toEqual([{ from: 104, to: 130, lo: 104, hi: null, bounds: 'both' }]);
  });
});
