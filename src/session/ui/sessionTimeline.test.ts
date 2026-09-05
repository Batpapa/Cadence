import { describe, it, expect } from 'vitest';
import { annotationsAt, withGaps, headPosition } from './timelineModel';
import type { SessionAnnotation } from '../model';

const ann = (id: string, start: number, end: number | null): SessionAnnotation => ({
  id, tuneId: id, settingId: id, displayName: id, dance: 'reel', meter: '4/4',
  start, end, confidence: 0.9, bucket: 'high', meanScore: 0.5, evidence: [], alternates: [],
  viterbiPick: { tuneId: id, settingId: id, displayName: id, dance: 'reel', meter: '4/4', meanScore: 0.5 },
  userConfirmed: false, liked: false, finalized: true,
});

describe('what the play head covers', () => {
  // Overlaps are the rule on real sessions, not the exception: 22 of 37
  // boundaries on a 48 min recording, by 5 to 10 s.
  const overlapping = [ann('a', 0, 70), ann('b', 60, 130)];

  it('reports BOTH tunes across a join rather than picking one', () => {
    expect(annotationsAt(overlapping, 65, 130)).toEqual(['a', 'b']);
  });

  it('reports the one tune everywhere else', () => {
    expect(annotationsAt(overlapping, 10, 130)).toEqual(['a']);
    expect(annotationsAt(overlapping, 100, 130)).toEqual(['b']);
  });

  it('reports nothing in a hole, rather than the last thing it saw', () => {
    expect(annotationsAt([ann('a', 0, 30), ann('b', 90, 120)], 60, 120)).toEqual([]);
  });

  it('reads an open annotation as running to the end', () => {
    expect(annotationsAt([ann('a', 0, null)], 500, 600)).toEqual(['a']);
  });
});

describe('the head standing in a silence', () => {
  const anns = [ann('a', 0, 30), ann('b', 120, 150)];

  it('names the silence it is in, so the list can light that row', () => {
    expect(headPosition(anns, 60, 200)).toEqual({ ids: [], gapFrom: 30 });
  });

  it('names no silence while a tune covers it', () => {
    expect(headPosition(anns, 10, 200)).toEqual({ ids: ['a'], gapFrom: null });
  });

  it('names no silence in a hole too short to be shown', () => {
    // Nothing is rendered there, so there is nothing to light.
    const tight = [ann('a', 0, 60), ann('b', 65, 120)];
    expect(headPosition(tight, 62, 120)).toEqual({ ids: [], gapFrom: null });
  });

  it('names the head and tail silences of a session', () => {
    expect(headPosition([ann('a', 30, 60)], 10, 120).gapFrom).toBe(0);
    expect(headPosition([ann('a', 30, 60)], 90, 120).gapFrom).toBe(60);
  });
});

describe('the silences shown in the list', () => {
  const kinds = (items: ReturnType<typeof withGaps>) => items.map((i: { kind: string }) => i.kind).join(',');

  it('shows a real pause between two tunes', () => {
    const items = withGaps([ann('a', 0, 60), ann('b', 180, 240)], 240);
    expect(kinds(items)).toBe('ann,gap,ann');
    const gap = items[1] as { kind: 'gap'; from: number; len: number };
    expect(gap.from).toBe(60);
    expect(gap.len).toBe(120);
  });

  it('says nothing about one hop of bound slop', () => {
    // 5 s between two tunes of a set is the window grid, not a silence.
    expect(kinds(withGaps([ann('a', 0, 60), ann('b', 65, 120)], 120))).toBe('ann,ann');
  });

  it('never invents a gap out of an overlap', () => {
    expect(kinds(withGaps([ann('a', 0, 70), ann('b', 60, 130)], 130))).toBe('ann,ann');
  });

  it('reports the head and tail of a session too', () => {
    expect(kinds(withGaps([ann('a', 30, 60)], 120))).toBe('gap,ann,gap');
  });

  it('measures a hole from the furthest point reached, not from the last start', () => {
    // A long tune swallowing a short one must not leave a phantom gap behind.
    const items = withGaps([ann('a', 0, 200), ann('b', 20, 40), ann('c', 260, 300)], 300);
    expect(kinds(items)).toBe('ann,ann,gap,ann');
    expect((items[2] as { from: number; len: number }).from).toBe(200);
  });
});
