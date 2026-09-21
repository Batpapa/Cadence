import { describe, it, expect } from 'vitest';
import type { Detection } from '../model';
import {
  contextWindow, waveformFitsContext, loupeDecodeWindow, clampBound,
  snapMarks, findSnap, findTwin, clampLinked, missingRanges,
  CTX_PAD_S, MIN_SPAN_S,
} from './boundEditorModel';

function det(id: string, start: number, end: number | null, name = id): Detection {
  return {
    id, tuneId: id, settingId: id, displayName: name, dance: 'jig', meter: '6/8',
    start, end, confidence: .8, bucket: 'high', meanScore: .8,
    evidence: [], alternates: [], userConfirmed: false, liked: false, finalized: true,
    viterbiPick: { tuneId: id, settingId: id, displayName: name, dance: 'jig', meter: '6/8', meanScore: .8 },
  };
}

describe('contextWindow', () => {
  it('pads both sides and clamps to the recording', () => {
    expect(contextWindow(100, 200, 600)).toEqual([100 - CTX_PAD_S, 200 + CTX_PAD_S]);
    expect(contextWindow(5, 200, 600)).toEqual([0, 200 + CTX_PAD_S]);
    expect(contextWindow(100, 590, 600)).toEqual([100 - CTX_PAD_S, 600]);
  });

  it('gives the context strip a waveform only up to the cap', () => {
    expect(waveformFitsContext([0, 600])).toBe(true);
    expect(waveformFitsContext([0, 601])).toBe(false);
  });
});

describe('loupeDecodeWindow', () => {
  it('stays inside the context window', () => {
    expect(loupeDecodeWindow(100, [0, 600])).toEqual([94, 106]);
    expect(loupeDecodeWindow(2, [0, 600])).toEqual([0, 8]);
    expect(loupeDecodeWindow(598, [0, 600])).toEqual([592, 600]);
  });
});

describe('clampBound', () => {
  const win: [number, number] = [70, 230];
  const draft = { start: 100, end: 200 };

  it('moves only the bound being edited', () => {
    expect(clampBound('start', 120, draft, win)).toEqual({ start: 120, end: 200 });
    expect(clampBound('end', 180, draft, win)).toEqual({ start: 100, end: 180 });
  });

  it('cannot leave the recording', () => {
    expect(clampBound('start', -5, draft, [0, 600]).start).toBe(0);
    expect(clampBound('end', 9999, draft, [0, 600]).end).toBe(600);
  });

  it('keeps the two bounds from crossing', () => {
    expect(clampBound('start', 500, draft, win).start).toBe(200 - MIN_SPAN_S);
    expect(clampBound('end', 0, draft, win).end).toBe(100 + MIN_SPAN_S);
  });
});

describe('missingRanges', () => {
  it('asks for everything when nothing is held', () => {
    expect(missingRanges([10, 50], [])).toEqual([[10, 50]]);
  });

  it('asks for nothing when it is all held', () => {
    expect(missingRanges([10, 50], [[0, 100]])).toEqual([]);
  });

  it('asks only for the holes, left to right', () => {
    expect(missingRanges([0, 100], [[20, 30], [60, 70]])).toEqual([[0, 20], [30, 60], [70, 100]]);
  });

  it('copes with unsorted and overlapping holdings', () => {
    expect(missingRanges([0, 100], [[60, 70], [10, 30], [25, 40]])).toEqual([[0, 10], [40, 60], [70, 100]]);
  });

  it('drops slivers, so a drag does not queue one-pixel jobs', () => {
    expect(missingRanges([0, 100], [[0, 99.5]])).toEqual([]);
    expect(missingRanges([0, 100], [[0, 95]])).toEqual([[95, 100]]);
  });
});

describe('snapMarks / findSnap', () => {
  const anns = [det('a', 10, 62, 'the kesh'), det('b', 58, 114, "morrison's"), det('c', 128, 177, 'silver spear')];
  const draft = { start: 58, end: 114 };

  it('offers the neighbours’ bounds and this detection’s other one', () => {
    const marks = snapMarks(anns, 'b', draft, 'start', 200);
    expect(marks.map(m => m.t).sort((x, y) => x - y))
      .toEqual([10, 62, 114, 128, 177]);
    // The edited detection's own start is not a mark for itself.
    expect(marks.some(m => m.t === 58)).toBe(false);
  });

  it('reads an open detection’s end as the session’s end', () => {
    const marks = snapMarks([det('a', 10, null)], 'b', draft, 'start', 200);
    expect(marks.some(m => m.t === 200 && m.edge === 'end')).toBe(true);
  });

  // A linked bound travels with ours, so offering it would be offering to
  // snap to where we already are.
  it('leaves out a bound that is linked to ours', () => {
    const marks = snapMarks(anns, 'b', draft, 'start', 200, new Set(['a']));
    expect(marks.some(m => m.id === 'a')).toBe(false);
    expect(marks.some(m => m.id === 'c')).toBe(true);
  });

  it('snaps to the nearest mark within tolerance, and to nothing outside it', () => {
    const marks = snapMarks(anns, 'b', draft, 'start', 200);
    expect(findSnap(62.2, marks)?.t).toBe(62);
    expect(findSnap(62.5, marks)).toBeNull();
  });

  it('prefers the nearer of two close marks', () => {
    const marks = snapMarks([det('a', 10, 62), det('d', 62.2, 90)], 'b', draft, 'start', 200);
    expect(findSnap(62.15, marks)?.t).toBe(62.2);
    expect(findSnap(62.05, marks)?.t).toBe(62);
  });
});

describe('findTwin', () => {
  // A set played straight through: the kesh runs into morrison's with no
  // silence, so their join is one instant written twice.
  const anns = [det('a', 10, 62, 'the kesh'), det('b', 62, 114, "morrison's"), det('c', 128, 177, 'silver spear')];

  it('finds the previous tune sitting on our start', () => {
    expect(findTwin(anns, 'b', 62, 'end', 200)).toEqual({ id: 'a', name: 'the kesh', edge: 'end' });
  });

  it('finds the next tune sitting on our end', () => {
    expect(findTwin(anns, 'c', 128, 'end', 200)).toBeNull();
    expect(findTwin(anns, 'b', 114, 'start', 200)).toBeNull();
    expect(findTwin([det('a', 10, 62), det('b', 62, 114)], 'a', 62, 'start', 200))
      .toEqual({ id: 'b', name: 'b', edge: 'start' });
  });

  it('says nothing when the bounds merely overlap, which is the norm', () => {
    expect(findTwin([det('a', 10, 65), det('b', 62, 114)], 'b', 62, 'end', 200)).toBeNull();
  });

  it('never twins a detection with itself', () => {
    expect(findTwin(anns, 'a', 10, 'start', 200)).toBeNull();
  });

  it('absorbs float arithmetic but not a real gap', () => {
    expect(findTwin([det('a', 10, 62.0005)], 'b', 62, 'end', 200)?.id).toBe('a');
    expect(findTwin([det('a', 10, 62.4)], 'b', 62, 'end', 200)).toBeNull();
  });

  it('reads an open detection’s end as the session’s end', () => {
    expect(findTwin([det('a', 10, null)], 'b', 200, 'end', 200)?.id).toBe('a');
  });
});

describe('clampLinked', () => {
  const prev = det('a', 10, 62, 'the kesh');
  const next = det('c', 114, 177, 'silver spear');

  it('leaves an unlinked pair alone', () => {
    expect(clampLinked({ start: 5, end: 300 }, null, null, 200)).toEqual({ start: 5, end: 300 });
  });

  it('will not drag the previous tune’s end past its own start', () => {
    expect(clampLinked({ start: 5, end: 114 }, prev, null, 200))
      .toEqual({ start: 10 + MIN_SPAN_S, end: 114 });
  });

  it('will not drag the next tune’s start past its own end', () => {
    expect(clampLinked({ start: 62, end: 190 }, null, next, 200))
      .toEqual({ start: 62, end: 177 - MIN_SPAN_S });
  });

  it('reads an open twin’s end as the session’s end', () => {
    expect(clampLinked({ start: 0, end: 500 }, null, det('c', 114, null), 200).end)
      .toBe(200 - MIN_SPAN_S);
  });

  it('gives up rather than make our own bounds cross', () => {
    // Squeezing from both sides would leave nothing between them.
    const pair = { start: 60, end: 60.5 };
    expect(clampLinked(pair, det('a', 59.9, 60), det('c', 60.5, 60.6), 200)).toBe(pair);
  });
});
