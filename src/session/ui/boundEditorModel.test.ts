import { describe, it, expect } from 'vitest';
import type { Detection } from '../model';
import {
  contextWindow, waveformFitsContext, loupeDecodeWindow, clampBound,
  snapMarks, findSnap, findTroughs, missingRanges,
  CTX_PAD_S, MIN_SPAN_S, PEAK_BUCKET_S,
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
    const marks = snapMarks(anns, 'b', draft, 'start', 200, []);
    expect(marks.filter(m => m.kind === 'bound').map(m => m.t).sort((x, y) => x - y))
      .toEqual([10, 62, 114, 128, 177]);
    // The edited detection's own start is not a mark for itself.
    expect(marks.some(m => m.t === 58)).toBe(false);
  });

  it('reads an open detection’s end as the session’s end', () => {
    const marks = snapMarks([det('a', 10, null)], 'b', draft, 'start', 200, []);
    expect(marks.some(m => m.t === 200 && m.edge === 'end')).toBe(true);
  });

  it('includes the silences it is given', () => {
    const marks = snapMarks(anns, 'b', draft, 'start', 200, [120.5]);
    expect(marks.find(m => m.kind === 'trough')?.t).toBe(120.5);
  });

  it('snaps to the nearest mark within tolerance, and to nothing outside it', () => {
    const marks = snapMarks(anns, 'b', draft, 'start', 200, []);
    expect(findSnap(62.2, marks)?.t).toBe(62);
    expect(findSnap(62.5, marks)).toBeNull();
  });

  it('prefers the nearer of two close marks', () => {
    const marks = snapMarks([det('a', 10, 62), det('d', 62.2, 90)], 'b', draft, 'start', 200, []);
    expect(findSnap(62.15, marks)?.t).toBe(62.2);
    expect(findSnap(62.05, marks)?.t).toBe(62);
  });
});

describe('findTroughs', () => {
  /** A window of `spans` — each [seconds, level] — as a peak array. */
  const build = (spans: Array<[number, number]>) => {
    const total = spans.reduce((s, [d]) => s + d, 0);
    const out = new Float32Array(Math.round(total / PEAK_BUCKET_S));
    let i = 0;
    for (const [d, level] of spans) {
      const n = Math.round(d / PEAK_BUCKET_S);
      for (let k = 0; k < n && i < out.length; k++, i++) out[i] = level;
    }
    return out;
  };

  it('finds a real pause and places it at its middle', () => {
    // 10 s of music, 4 s of near-silence, 10 s of music.
    const peaks = build([[10, .8], [4, .02], [10, .8]]);
    const troughs = findTroughs(peaks, 100);
    expect(troughs).toHaveLength(1);
    expect(troughs[0]!).toBeCloseTo(112, 0);
  });

  it('ignores the gaps between notes', () => {
    // A note every 200 ms with a 60 ms tail of quiet: far too short to be a place.
    const spans: Array<[number, number]> = [];
    for (let k = 0; k < 60; k++) { spans.push([.14, .8]); spans.push([.06, .02]); }
    expect(findTroughs(build(spans), 0)).toEqual([]);
  });

  it('reads a quiet recording on its own terms, not against an absolute', () => {
    // The same shape a hundred times quieter still has its pause found.
    const peaks = build([[10, .008], [4, .0002], [10, .008]]);
    expect(findTroughs(peaks, 0)).toHaveLength(1);
  });

  it('only reads the decoded head of the array', () => {
    const peaks = new Float32Array(Math.round(30 / PEAK_BUCKET_S));
    const filled = build([[10, .8], [4, .02], [6, .8]]);
    peaks.set(filled, 0);
    // The tail is still zeroes — reading it would invent a silence at the end.
    const troughs = findTroughs(peaks, 0, filled.length);
    expect(troughs).toHaveLength(1);
    expect(troughs[0]!).toBeCloseTo(12, 0);
  });

  it('says nothing about an empty or silent window', () => {
    expect(findTroughs(new Float32Array(0), 0)).toEqual([]);
    expect(findTroughs(new Float32Array(1000), 0)).toEqual([]);
  });
});
