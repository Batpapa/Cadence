import { describe, it, expect } from 'vitest';
import { followScore, positionAt, contourToMidi, contourSlots, alignContour, localMatch, quaverToMs, msToQuaver, FOLLOW_FPS, type TimelineEvent } from './scoreFollow';

describe('contour quavers on the drawn score', () => {
  // |:D|G3 GAB|A/B/c z B3:| in 6/8, a quaver = 333 ms, played twice by abcjs.
  const q = 1000 / 3;
  const pass = [0, 1, 4, 5, 6, 7, 7.5, 8, 9, 10].map(x => x * q);
  const rest = 9 * q;
  const events: TimelineEvent[] = [0, 13].flatMap(off => pass.map(ms => ({
    milliseconds: ms + off * q, millisecondsPerMeasure: 6 * q, isNote: ms !== rest,
  })));
  const last = 26 * q;
  const slots = contourSlots(events, last, '6/8');

  it('follows the index builder: rests dropped, a semiquaver pair takes one quaver', () => {
    // D, G×3, G, A, B, A/ (B/ skipped), c, B×3 — twelve per pass.
    expect(slots).toHaveLength(24);
    expect(slots[9]).toBeCloseTo(10 * q); // the B3 after the rest
    expect(slots[12]).toBeCloseTo(13 * q); // second time round
  });

  it('takes abcjs\'s millisecond rounding for what it is (a reel at 333.3 ms a quaver)', () => {
    // Sixteen plain quavers, their times rounded as abcjs gives them: some
    // measure 1.001 quavers. Each must still be one slot, on its own note.
    const rq = 1000 / 3;
    const ev: TimelineEvent[] = Array.from({ length: 16 }, (_, i) => ({
      milliseconds: Math.round(i * rq), millisecondsPerMeasure: Math.round(8 * rq), isNote: true,
    }));
    const s = contourSlots(ev, Math.round(16 * rq), '4/4');
    expect(s).toHaveLength(16);
    s.forEach((ms, i) => expect(ms).toBe(Math.round(i * rq)));
  });

  it('maps a quaver to its moment and back', () => {
    expect(quaverToMs(9, 24, slots, last)).toBeCloseTo(10 * q);
    expect(quaverToMs(9.5, 24, slots, last)).toBeCloseTo(10.5 * q);
    expect(msToQuaver(10 * q, 24, slots, last)).toBe(9);
    // A contour two quavers longer than the slots: stretched, not drifting.
    expect(quaverToMs(26, 26, slots, last)).toBeCloseTo(last);
  });
});

/** Features of a performance: each quaver lights its pitch (plus a weaker
 *  octave and some spread), over a little noise. */
function perform(score: number[], { passes = 3, quaverS = 0.14, lead = 2, drift = 0.08, octave = 0 } = {}) {
  const onsets: Array<{ t: number; index: number }> = [];
  let t = lead;
  const total = score.length * passes;
  for (let n = 0; n < total; n++) {
    onsets.push({ t, index: n % score.length });
    t += quaverS * (1 + drift * Math.sin((2 * Math.PI * n) / total));
  }
  const frames = Math.ceil((t + lead) * FOLLOW_FPS);
  const f = new Float32Array(frames * 48);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let fr = 0; fr < frames; fr++) for (let p = 0; p < 48; p++) f[fr * 48 + p] = 0.02 * rnd();
  onsets.forEach((o, k) => {
    const a = Math.floor(o.t * FOLLOW_FPS);
    const b = k + 1 < onsets.length ? Math.floor(onsets[k + 1]!.t * FOLLOW_FPS) : Math.floor(t * FOLLOW_FPS);
    const p = score[o.index]! - 48 + octave;
    for (let fr = a; fr < b; fr++) {
      f[fr * 48 + p] = 1;
      if (p + 1 < 48) f[fr * 48 + p + 1] = 0.2;
      if (p > 0) f[fr * 48 + p - 1] = 0.2;
    }
  });
  return { f, onsets };
}

const tune = contourToMidi('ooqxxvxxqxxxvxAxvtsovoxovosovoAvsoqxxvxxqxxxvxACEFHECzAxvsoqsoqq');

describe('score following', () => {
  it('reads the index contour alphabet', () => {
    expect(contourToMidi('aAV')).toEqual([48, 74, 95]);
  });

  it('finds every quaver of a drifting performance, passes included', () => {
    const { f, onsets } = perform(tune);
    const r = followScore(f, tune)!;
    expect(r).not.toBeNull();
    // Every played quaver, matched to the nearest aligned onset of the same index.
    const errs = onsets.map(o => {
      let e = Infinity;
      r.times.forEach((t, k) => { if (r.indices[k] === o.index && Math.abs(t - o.t) < Math.abs(e)) e = t - o.t; });
      return Math.abs(e);
    }).sort((a, b) => a - b);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.05);
    expect(r.match).toBeGreaterThan(0.8);
  });

  it('follows a performance heard an octave up', () => {
    const { f } = perform(tune, { octave: 12 });
    const r = followScore(f, tune)!;
    expect(r.times.length).toBeGreaterThan(tune.length * 2.5);
  });

  it('places the cursor: nothing before the tune, the pass after a wrap', () => {
    const { f, onsets } = perform(tune);
    const r = followScore(f, tune)!;
    expect(positionAt(r, 0.5)).toBeNull();
    const second = onsets[tune.length + 5]!;
    const at = positionAt(r, second.t + 0.07)!;
    expect(at.pass).toBe(1);
    expect(Math.abs(at.quaver - 5.5)).toBeLessThan(0.6);
  });

  it('knows the score\'s length when the recording covers only part of it', () => {
    // Half a pass played: the highest quaver reached is ~32, the score has 64.
    // Positions are read against 64 — against 32 the cursor raced to the end.
    const half = tune.slice(0, 32);
    const { f } = perform(half, { passes: 1 });
    const r = followScore(f, tune)!;
    expect(r.quavers).toBe(tune.length);
    expect(Math.max(...r.indices)).toBeLessThan(40);
  });

  it('a wrong score aligns worse than the right one', () => {
    const { f } = perform(tune);
    const other = contourToMidi('ttttvxvvvvxACAAFAACAxAxvtvttvxvxvvxACAAFAAxvstttttttvxvvvvxACAAF');
    expect(followScore(f, tune)!.perFrame).toBeGreaterThan(followScore(f, other)!.perFrame + 0.3);
  });
});

describe('how well the score holds, stretch by stretch', () => {
  // Eight quavers a second apart: the first four right, the last four wrong.
  const r = {
    times: [0, 1, 2, 3, 4, 5, 6, 7], indices: [0, 1, 2, 3, 4, 5, 6, 7], end: 8,
    hits: [10, 10, 10, 10, 0, 0, 0, 0], counted: [10, 10, 10, 10, 10, 10, 10, 10],
  } as unknown as Parameters<typeof localMatch>[0];

  it('reads the quavers around each moment, and nothing outside the aligned span', () => {
    expect(localMatch(r, [-1, 1, 6, 9], 1)).toEqual([null, 1, 0, null]);
  });

  it('mixes what a window straddles', () => {
    // 3.5 ± 1 s: the quavers at 3 (right) and 4 (wrong).
    expect(localMatch(r, [3.5], 1)).toEqual([0.5]);
  });

  it('counts a long quaver under a narrow window', () => {
    expect(localMatch({ ...r, times: [0, 10], hits: [3, 0], counted: [4, 4], end: 20 }, [5], 0.5)).toEqual([0.75]);
  });

  it('says nothing where no frame had a pitch', () => {
    expect(localMatch({ ...r, counted: r.counted.map(() => 0), hits: r.hits.map(() => 0) }, [2], 1)).toEqual([null]);
  });
});

describe('placing the contour on the drawn notes', () => {
  const notes = (pitch: number[], step = 100) => ({ ms: pitch.map((_, i) => i * step), pitch });

  it('keeps one quaver to one slot when they agree', () => {
    expect(alignContour([60, 62, 64, 65], notes([60, 62, 64, 65]))).toEqual([0, 100, 200, 300]);
  });

  it('puts a quaver the drawing lacks after the note it repeats, not before', () => {
    // The contour spells a triplet out as three quavers; the drawing has one slot.
    expect(alignContour([60, 62, 62, 62, 64], notes([60, 62, 64]))).toEqual([0, 100, 100 + 100 / 3, 100 + 200 / 3, 200]);
  });

  it('keeps what follows extra quavers in place instead of shifting it', () => {
    const drawn = [67, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 66];
    const contour = [67, 69, 69, 69, 71, 72, 74, 76, 74, 72, 71, 69, 67, 66];
    const at = alignContour(contour, notes(drawn))!;
    // The last six quavers land exactly on the last six drawn notes.
    expect(at.slice(-6)).toEqual([600, 700, 800, 900, 1000, 1100]);
  });

  it('reads pitch classes at the shift the drawing is transposed by', () => {
    expect(alignContour([60, 62, 64, 65], notes([62, 64, 66, 67]))).toEqual([0, 100, 200, 300]);
  });

  it('gives up without pitches, or when too few match', () => {
    expect(alignContour([60, 62, 64], { ms: [0, 100, 200], pitch: [undefined, undefined, undefined] })).toBeNull();
    expect(alignContour([60, 61, 62, 63, 64], notes([70, 70, 70, 70, 70]))).toBeNull();
  });
});
