import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import {
  classNotes, withOctaves, quaverGrid, metreOf, makeKey, keyOfAbc, writeAbc, quaverContour,
  type ClassNote, type Transcription, type GridNote,
} from './transcription';

const flat = (notes: ClassNote[]): Float32Array =>
  Float32Array.from(notes.flatMap(n => [n.cls, n.start, n.frames, n.power, ...n.octaves]));

/** A note of class `cls` whose energy is `octaves` (from MIDI 48 up). */
const note = (cls: number, start: number, octaves: number[], frames = 6, power = 0.5): ClassNote =>
  ({ cls, start, frames, power, octaves });

/** What abcjs plays of `abc`: [MIDI pitch, length in quavers] per sounding note, ties joined. */
function played(abc: string): [number, number][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tune = abcjs.parseOnly(`X: 1\nT: t\n${abc}`)[0] as any;
  expect(tune.warnings ?? []).toEqual([]);
  const quaver = 0.125; // abcjs counts in whole notes
  return tune.setUpAudio({}).tracks.flat()
    .filter((e: { cmd: string }) => e.cmd === 'note')
    .map((e: { pitch: number; duration: number }) => [e.pitch, Math.round(e.duration / quaver)]);
}

describe('classNotes', () => {
  it('reads transcribe_notes\' 8 values a note', () => {
    const n = note(2, 10, [1, 2, 3, 4], 7, 0.25);
    expect(classNotes(flat([n, n]))).toEqual([n, n]);
  });
});

describe('withOctaves', () => {
  it('drops the notes FolkFriend drops: weak or under 3 frames', () => {
    const out = withOctaves(classNotes(flat([
      note(2, 0, [0, 1, 0, 0]), note(4, 6, [0, 1, 0, 0], 2), note(5, 8, [0, 1, 0, 0], 6, 0.05), note(7, 14, [0, 1, 0, 0]),
    ])));
    expect(out.map(n => n.pitch)).toEqual([62, 67]);
  });

  it('keeps the melody line where the loudest octave would leap', () => {
    // A B c# d e: the d heard a little louder an octave below (MIDI 62) than at 74
    const out = withOctaves(classNotes(flat([
      note(9, 0, [0, 1, 0.1, 0]), note(11, 6, [0, 1, 0.1, 0]), note(1, 12, [0, 0, 1, 0]),
      note(2, 18, [0, 0.55, 0.45, 0]), note(4, 24, [0, 0, 1, 0]),
    ])));
    expect(out.map(n => n.pitch)).toEqual([69, 71, 73, 74, 76]);
  });

  it('follows an octave leap the energy is sure of over several notes', () => {
    // a leap costs 12 x 0.6: one note an octave off would cost less, three do not
    const out = withOctaves(classNotes(flat([
      note(2, 0, [0, 1, 0, 0]), note(4, 6, [0, 1, 0, 0]), note(2, 12, [0, 1, 0, 0]),
      note(2, 18, [0, 0, 1, 0]), note(4, 24, [0, 0, 1, 0]), note(2, 30, [0, 0, 1, 0]),
    ])));
    expect(out.map(n => n.pitch)).toEqual([62, 64, 62, 74, 76, 74]);
  });
});

describe('quaverGrid', () => {
  it('steps at the period, on the onsets', () => {
    const signal = new Float32Array(400);
    for (let t = 5; t < 400; t += 10) signal[t] = 1;
    const grid = quaverGrid(signal, 10);
    const steps = grid.slice(1).map((g, i) => g - grid[i]!);
    expect(steps.every(s => s === 10)).toBe(true);
    expect(grid[1]! % 10).toBe(5);
  });

  it('follows a tempo that drifts', () => {
    // onsets 10 frames apart, then 11
    const signal = new Float32Array(500);
    let t = 3;
    for (let k = 0; t < 500; k++) { signal[t] = 1; t += k < 20 ? 10 : 11; }
    const grid = quaverGrid(signal, 10.5);
    const onsets = new Set<number>(); for (let u = 0; u < 500; u++) if (signal[u]) onsets.add(u);
    expect(grid.filter(g => onsets.has(g)).length).toBeGreaterThanOrEqual(onsets.size - 2);
  });
});

describe('metreOf', () => {
  /** A novelty pulsing every P frames, stronger every `bar` pulses; flat features. */
  function pulses(bar: number, P = 8, n = 3000): { novelty: Float32Array; features: Float32Array } {
    const novelty = new Float32Array(n);
    for (let k = 0; k * P < n; k++) novelty[k * P] = k % bar === 0 ? 3 : k % (bar / 2) === 0 && bar % 2 === 0 ? 2 : 1;
    const features = new Float32Array(n * 48).fill(1);
    return { novelty, features };
  }
  it('hears jigs in threes', () => {
    const { novelty, features } = pulses(6);
    expect(metreOf(novelty, features, 8)).toBe('6/8');
  });
  it('hears reels in twos and fours', () => {
    const { novelty, features } = pulses(8);
    expect(metreOf(novelty, features, 8)).toBe('4/4');
  });
});

describe('keys', () => {
  it('names and signs the modes', () => {
    expect(makeKey(2, 'maj')).toMatchObject({ name: 'Dmaj', signature: { F: 1, C: 1, G: 0 } });
    expect(makeKey(9, 'dor')).toMatchObject({ name: 'Ador', signature: { F: 1, C: 0, B: 0 } });
    expect(makeKey(4, 'min')).toMatchObject({ name: 'Emin', signature: { F: 1, C: 0 } });
    expect(makeKey(2, 'mix')).toMatchObject({ name: 'Dmix', signature: { F: 1, C: 0 } });
    expect(makeKey(6, 'min').name).toBe('F#min');
    expect(makeKey(10, 'maj')).toMatchObject({ name: 'Bbmaj', flat: true });
  });

  it('reads FolkFriend\'s key line', () => {
    expect(keyOfAbc('K:Edor\nABc |')?.name).toBe('Edor');
    expect(keyOfAbc('K:F#min\n')?.name).toBe('F#min');
    expect(keyOfAbc('no key')).toBeNull();
  });
});

describe('writeAbc', () => {
  /** Notes one after the other from grid position `from`, bars every `bar` quavers from
   *  `first`. */
  function tune(notes: [number, number][], bar: number, first = 0, from = 0, metre: '4/4' | '6/8' = '4/4'): Transcription {
    let at = from;
    const gridNotes: GridNote[] = notes.map(([pitch, quavers]) => { const n = { pitch, at, quavers, sounds: quavers }; at += quavers; return n; });
    const bars = Array.from({ length: at + 1 }, (_, k) => k >= first && (k - first) % bar === 0);
    return { notes: gridNotes, bars, grid: [], metre, rate: 7 };
  }

  it('writes a D major scale under its signature, beamed in fours', () => {
    const t = tune([[62, 1], [64, 1], [66, 1], [67, 1], [69, 1], [71, 1], [73, 1], [74, 1]], 8);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc).toBe('M:4/4\nL:1/8\nQ:1/4=210\nK:Dmaj\nDEFG ABcd |]');
    expect(played(abc)).toEqual(t.notes.map(n => [n.pitch, 1]));
  });

  it('marks an accidental once in its bar, and again after the bar line', () => {
    // in D major: F natural twice, then F natural in the next bar
    const t = tune([[65, 1], [65, 1], [64, 2], [62, 4], [65, 8]], 8);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc.split('\n').pop()).toBe('=FF E2 D4 | =F8 |]');
    expect(played(abc).map(p => p[0])).toEqual([65, 65, 64, 62, 65]);
  });

  it('ties a note across a bar line, and writes lengths a note can show', () => {
    const t = tune([[69, 6], [71, 5], [74, 5]], 8);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc.split('\n').pop()).toBe('A6 B2- | B3 d4- d |]');
    expect(played(abc)).toEqual([[69, 6], [71, 5], [74, 5]]);
  });

  it('writes a pickup before the first bar line', () => {
    const t = tune([[62, 1], [67, 3], [71, 3], [74, 6]], 6, 1, 0, '6/8');
    const abc = writeAbc(t, makeKey(7, 'maj'));
    expect(abc).toContain('M:6/8');
    expect(abc).toContain('Q:3/8=140');
    expect(abc.split('\n').pop()).toBe('D | G3 B3 | d6 |]');
  });

  it('writes a silence of a crotchet or more as a rest', () => {
    const notes: GridNote[] = [{ pitch: 62, at: 0, quavers: 4, sounds: 1 }, { pitch: 64, at: 4, quavers: 2, sounds: 1 }, { pitch: 66, at: 6, quavers: 2, sounds: 2 }];
    const t: Transcription = { notes, bars: [true, false, false, false, false, false, false, false, true], grid: [], metre: '4/4', rate: 7 };
    expect(writeAbc(t, makeKey(2, 'maj')).split('\n').pop()).toBe('D z3 E2 F2 |]');
  });

  it('breaks the lines every 4 bars, and every note it plays is the transcription\'s', () => {
    const pitches = [62, 64, 66, 67, 69, 71, 73, 74, 76, 78, 79, 81, 83, 85, 86, 72, 65, 60, 59, 57];
    const notes = Array.from({ length: 48 }, (_, k): [number, number] => [pitches[k % pitches.length]!, 1 + (k % 3 === 0 ? 1 : 0)]);
    const t = tune(notes, 8, 3);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc.split('\n').length).toBeGreaterThan(5);
    expect(played(abc)).toEqual(notes);
    expect(quaverContour(t).length).toBe(notes.reduce((s, n) => s + n[1], 0));
  });
});
