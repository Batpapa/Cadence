import { describe, it, expect } from 'vitest';
import abcjs from 'abcjs';
import { swingJigNotes, swingAudioParams, JIG_SWING_SHAPE, type SwingNote } from './jigSwing';
import { meterCanSwing } from './abcService';

/** The notes abcjs would play, as its note map has them (gap left out), and
 *  where its first full bar starts. */
function notesOf(music: string, meter = '6/8'): { notes: SwingNote[]; pickup: number } {
  const abc = `X: 1\nT: t\nM: ${meter}\nL: 1/8\nK: D\n${music}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tune = abcjs.parseOnly(abc)[0] as any;
  const notes = tune.setUpAudio({}).tracks.flat()
    .filter((e: { cmd: string }) => e.cmd === 'note')
    .map((e: { start: number; duration: number }) => ({ start: e.start, end: e.start + e.duration }));
  return { notes, pickup: tune.getPickupLength() };
}

const r = (x: number) => Math.round(x * 1e6) / 1e6;
const starts = (ns: SwingNote[]) => ns.map(n => r(n.start));
/** The three parts of a beat for a setting, in whole notes: the first quaver
 *  gains what a reel's would (swing / 50 − 1), and the shape says who loses
 *  it. Written out independently of the module, so a mistake in one does not
 *  hide in the other. */
const parts = (swing: number) => {
  const k = swing / 50 - 1;
  const [a, b, c] = JIG_SWING_SHAPE === 'longShortShort' ? [1 + k, 1 - k / 2, 1 - k / 2] : [1 + k, 1 - k, 1];
  return { a: a / 8, b: b / 8, c: c / 8 };
};

describe('swingJigNotes', () => {
  it('lengthens the first quaver as a reel would, the shape deciding the rest', () => {
    const { notes, pickup } = notesOf('ABc def|');
    swingJigNotes([notes], 75, pickup);
    const { a, b, c } = parts(75);
    expect(starts(notes)).toEqual([0, r(a), r(a + b), 0.375, r(0.375 + a), r(0.375 + a + b)]);
    const lengths = notes.map(n => n.end - n.start);
    expect(lengths.slice(0, 3).map(r)).toEqual([r(a), r(b), r(c)]);
    // Strong: the first quaver gains half a quaver, as in a reel.
    expect(lengths[0]! * 8).toBeCloseTo(1.5, 9);
  });

  it('never moves a beat', () => {
    const { notes, pickup } = notesOf('ABc def|g3 f2e|');
    const onBeats = (ns: SwingNote[]) => ns.filter(n => Math.abs(n.start / 0.375 - Math.round(n.start / 0.375)) < 1e-6).map(n => r(n.start));
    const before = onBeats(notes);
    swingJigNotes([notes], 75, pickup);
    expect(onBeats(notes)).toEqual(before);
  });

  it('counts beats from the first full bar when there is a pickup', () => {
    const { notes, pickup } = notesOf('A|BcB AFD|');
    expect(pickup).toBe(0.125);
    swingJigNotes([notes], 66, pickup);
    const { a, b, c } = parts(66);
    // The pickup is the last part of a beat: it starts where a third does.
    expect(starts(notes)).toEqual([
      r(0.125 - c),
      0.125, r(0.125 + a), r(0.125 + a + b),
      0.5, r(0.5 + a), r(0.5 + a + b),
    ]);
  });

  it('puts every rhythm on the same grid', () => {
    const { a, b } = parts(75);
    // A crotchet and a quaver: the crotchet takes the first two parts.
    const cB = notesOf('c2B A3|');
    swingJigNotes([cB.notes], 75, cB.pickup);
    expect(starts(cB.notes).slice(0, 2)).toEqual([0, r(a + b)]);
    // A roll in semiquavers is stretched with the quaver it fills.
    const roll = notesOf('A/B/cd e3|');
    expect(roll.pickup).toBe(0);
    swingJigNotes([roll.notes], 75, roll.pickup);
    expect(starts(roll.notes).slice(0, 3)).toEqual([0, r(a / 2), r(a)]);
  });

  it('swings slip jigs and slides the same way', () => {
    const slip = notesOf('ABc ABc ABc|', '9/8');
    swingJigNotes([slip.notes], 75, slip.pickup);
    const { a, b } = parts(75);
    expect(starts(slip.notes)).toEqual([0, 0.375, 0.75].flatMap(t => [t, r(t + a), r(t + a + b)]));
  });

  it('moves a chord as one, and keeps each note its own gap', () => {
    const notes: SwingNote[] = [
      { start: 0, end: 0.1 }, { start: 0, end: 0.125 },
      { start: 0.125, end: 0.25 },
    ];
    swingJigNotes([notes], 75, 0);
    const { a, b } = parts(75);
    expect(notes.map(n => [r(n.start), r(n.end)])).toEqual([[0, r(0.8 * a)], [0, r(a)], [r(a), r(a + b)]]);
  });

  it('does nothing when straight', () => {
    const { notes, pickup } = notesOf('ABc def|');
    const before = starts(notes);
    swingJigNotes([notes], 50, pickup);
    expect(starts(notes)).toEqual(before);
  });
});

describe('swingAudioParams', () => {
  it('lets abcjs swing simple time and swings compound time itself', () => {
    expect(swingAudioParams(66, { num: 4, den: 4 }, 0)).toEqual({ swing: 66 });
    expect(swingAudioParams(66, { num: 2, den: 4 }, 0)).toEqual({ swing: 66 });
    const jig = swingAudioParams(66, { num: 6, den: 8 }, 0);
    expect(jig.swing).toBeUndefined();
    expect(typeof jig.sequenceCallback).toBe('function');
    expect(swingAudioParams(66, { num: 5, den: 8 }, 0)).toEqual({});
    expect(swingAudioParams(50, { num: 6, den: 8 }, 0)).toEqual({});
  });

  it('agrees with meterCanSwing on which metres swing', () => {
    for (const [m, num, den] of [['4/4', 4, 4], ['2/4', 2, 4], ['6/8', 6, 8], ['9/8', 9, 8], ['12/8', 12, 8], ['3/8', 3, 8], ['5/8', 5, 8], ['7/8', 7, 8], ['3/2', 3, 2]] as const) {
      const swung = Object.keys(swingAudioParams(66, { num, den }, 0)).length > 0;
      expect(meterCanSwing(m), m).toBe(swung);
    }
  });
});
