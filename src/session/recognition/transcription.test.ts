import { describe, expect, it } from 'vitest';
import abcjs from 'abcjs';
import {
  classNotes, withOctaves, quaverGrid, metreOf, makeKey, modeOn, keyOfAbc, writeAbc, quaverContour, transcribe, parseMetre,
  type ClassNote, type Transcription, type GridNote,
} from './transcription';

const flat = (notes: ClassNote[]): Float32Array =>
  Float32Array.from(notes.flatMap(n => [n.cls, n.start, n.frames, n.power, ...n.octaves]));

/** A note of class `cls` whose energy is `octaves` (from MIDI 48 up). */
const note = (cls: number, start: number, octaves: number[], frames = 6, power = 0.5): ClassNote =>
  ({ cls, start, frames, power, octaves });

/** What abcjs plays of `abc`: [MIDI pitch, length in quavers, to the semiquaver] per
 *  sounding note, ties joined. */
function played(abc: string): [number, number][] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tune = abcjs.parseOnly(`X: 1\nT: t\n${abc}`)[0] as any;
  expect(tune.warnings ?? []).toEqual([]);
  const quaver = 0.125; // abcjs counts in whole notes
  return tune.setUpAudio({}).tracks.flat()
    .filter((e: { cmd: string }) => e.cmd === 'note')
    .map((e: { pitch: number; duration: number }) => [e.pitch, Math.round(2 * e.duration / quaver) / 2]);
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

  it('trusts a note heard only an octave up, a sixth from the notes around it', () => {
    // A f A (the user's recording): f heard at F5 alone, not F4
    const out = withOctaves(classNotes(flat([
      note(9, 0, [0, 1, 0, 0]), note(5, 6, [0, 0, 1, 0]), note(9, 12, [0, 1, 0, 0]),
    ])));
    expect(out.map(n => n.pitch)).toEqual([69, 77, 69]);
  });

  it('follows an octave leap the energy is sure of over several notes', () => {
    // a leap costs 12 x 0.4: one note an octave off would cost less, three do not
    const out = withOctaves(classNotes(flat([
      note(2, 0, [0, 1, 0, 0]), note(4, 6, [0, 1, 0, 0]), note(2, 12, [0, 1, 0, 0]),
      note(2, 18, [0, 0, 1, 0]), note(4, 24, [0, 0, 1, 0]), note(2, 30, [0, 0, 1, 0]),
    ])));
    expect(out.map(n => n.pitch)).toEqual([62, 64, 62, 74, 76, 74]);
  });

  it('keeps a run heard louder an octave up in the register of the notes around it', () => {
    // D E F# G A over and over, G A G A... heard mostly an octave up for 8 notes: worth its two
    // leaps on energy alone, not against the register
    const cls = [2, 4, 6, 7, 9];
    const notes = Array.from({ length: 40 }, (_, k) => k >= 16 && k < 24
      ? note([7, 9][k % 2]!, 6 * k, [0, 0.1, 0.9, 0])
      : note(cls[k % 5]!, 6 * k, [0, 1, 0, 0]));
    const out = withOctaves(classNotes(flat(notes)));
    expect(out.slice(16, 24).map(n => n.pitch)).toEqual([67, 69, 67, 69, 67, 69, 67, 69]);
    expect(out.every(n => n.pitch < 72)).toBe(true);
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

describe('transcribe', () => {
  const FPS = 40, RATE = 4, P = FPS / RATE, FRAMES = 200;
  /** Notes [MIDI pitch, first frame, frames, frames it sounds]; a novelty pulse on every
   *  grid point (frame 5 + 10 k), `accents` overriding some; each note's energy while it sounds. */
  function scene(notes: [number, number, number, number?][], accents: Record<number, number> = {}) {
    const classes = flat(notes.map(([pitch, start, frames]) => {
      const octaves = [0, 0, 0, 0];
      octaves[Math.floor((pitch - 48) / 12)] = 1;
      return note((pitch - 48) % 12, start, octaves, frames);
    }));
    const novelty = new Float32Array(FRAMES);
    for (let f = 5; f < FRAMES; f += P) novelty[f] = 1;
    for (const [f, v] of Object.entries(accents)) novelty[Number(f)] = v;
    const features = new Float32Array(FRAMES * 48);
    for (const [pitch, start, frames, sounds] of notes) {
      for (let f = start; f < start + (sounds ?? frames); f++) features[f * 48 + pitch - 48] = 1;
    }
    return transcribe(classes, novelty, features, FPS, RATE)!;
  }

  it('puts a dotted pair\'s short note on its own quaver, not on the next note\'s', () => {
    // B (1.5 quavers) c (0.5) d B A G: c's onset halfway between two grid points
    const t = scene([[71, 5, 15], [72, 20, 5], [74, 25, 10], [71, 35, 10], [69, 45, 10], [67, 55, 10]]);
    expect(t.notes.map(n => n.pitch)).toEqual([71, 72, 74, 71, 69, 67]);
    expect(t.notes.map(n => n.at - t.notes[0]!.at)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  /** 160 quavers of even pairs, bars of `bar` accented, `dotted` quavers (odd: a pair's
   *  second) late by half a quaver; with `tail`, a last A on the next downbeat, a quaver of
   *  it heard. */
  function pairs(dotted: number[], bar = 8, tail = false) {
    const N = 160 + (tail ? 1 : 0), frames = 5 + N * P + 20;
    const pitches = [69, 71, 72, 74, 76, 74, 72, 71];
    const notes: [number, number, number][] = [];
    for (let k = 0; k < N; k++) {
      const start = 5 + k * P + (dotted.includes(k) ? P / 2 : 0);
      const next = 5 + (k + 1) * P + (dotted.includes(k + 1) ? P / 2 : 0);
      notes.push([k >= 160 ? 69 : pitches[k % pitches.length]!, start, next - start]);
    }
    const classes = flat(notes.map(([pitch, start, length]) => {
      const octaves = [0, 0, 0, 0];
      octaves[Math.floor((pitch - 48) / 12)] = 1;
      return note((pitch - 48) % 12, start, octaves, length);
    }));
    const novelty = new Float32Array(frames);
    for (let k = 0; k < N; k++) novelty[5 + k * P] = k % bar === 0 ? 3 : k % (bar / 2) === 0 && bar % 2 === 0 ? 2 : 1;
    const features = new Float32Array(frames * 48);
    for (const [pitch, start, length] of notes) for (let f = start; f < start + length; f++) features[f * 48 + pitch - 48] = 1;
    return transcribe(classes, novelty, features, FPS, RATE)!;
  }

  it('hears a dotted pair where the second note comes late, in a steady recording', () => {
    const t = pairs([17, 41]);
    expect(t.metre).toBe('4/4');
    const broken = t.notes.filter(n => n.broken);
    expect(broken.map(n => [n.pitch, n.broken])).toEqual([[69, '>'], [69, '>']]);
  });

  it('holds the last note to the end of its bar', () => {
    const t = pairs([], 8, true);
    const last = t.notes[t.notes.length - 1]!;
    expect([last.pitch, last.quavers, last.sounds]).toEqual([69, 8, 8]);
  });

  it('writes no dotted pair in a jig', () => {
    const t = pairs([17, 41], 6);
    expect(t.metre).toBe('6/8');
    expect(t.notes.some(n => n.broken)).toBe(false);
  });

  it('splits a re-attacked note, not one whose sound has stopped', () => {
    // F# held 4 quavers by the decoder, an accent on its last quaver
    const notes = (sounds: number): [number, number, number, number?][] =>
      [[62, 5, 10], [64, 15, 10], [66, 25, 40, sounds], [67, 65, 10], [69, 75, 10]];
    const accents = { 35: 0.1, 45: 0.1, 55: 2 };
    const held = scene(notes(40), accents).notes.filter(n => n.pitch === 66);
    expect(held.map(n => n.quavers)).toEqual([3, 1]);
    const stopped = scene(notes(20), accents).notes.filter(n => n.pitch === 66);
    expect(stopped.map(n => n.quavers)).toEqual([4]);
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
    // six sharps or six flats: the tonic named as its major key is (the circle of fifths)
    expect(makeKey(3, 'min')).toMatchObject({ name: 'Ebmin', flat: true });
    expect(makeKey(8, 'dor').name).toBe('Abdor');
    expect(makeKey(1, 'mix').name).toBe('Dbmix');
    expect(makeKey(6, 'maj').name).toBe('F#maj');
    expect(makeKey(1, 'min').name).toBe('C#min');
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
  function tune(notes: [number, number][], bar: number, first = 0, from = 0, metre = '4/4'): Transcription {
    let at = from;
    const gridNotes: GridNote[] = notes.map(([pitch, quavers]) => { const n = { pitch, at, quavers, sounds: quavers }; at += quavers; return n; });
    const bars = Array.from({ length: at + 1 }, (_, k) => k >= first && (k - first) % bar === 0);
    return { notes: gridNotes, bars, grid: [], metre, rate: 7 };
  }

  it('writes a D major scale under its signature, beamed in fours', () => {
    const t = tune([[62, 1], [64, 1], [66, 1], [67, 1], [69, 1], [71, 1], [73, 1], [74, 1]], 8);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc).toBe('M:4/4\nL:1/8\nQ:1/4=210\nK:Dmaj\nDEFG ABcd|]');
    expect(played(abc)).toEqual(t.notes.map(n => [n.pitch, 1]));
  });

  it('marks an accidental once in its bar, and again after the bar line', () => {
    // in D major: F natural twice, then F natural in the next bar
    const t = tune([[65, 1], [65, 1], [64, 2], [62, 4], [65, 8]], 8);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc.split('\n').pop()).toBe('=FF E2 D4| =F8|]');
    expect(played(abc).map(p => p[0])).toEqual([65, 65, 64, 62, 65]);
  });

  it('ties a note across a bar line, and writes lengths a note can show', () => {
    const t = tune([[69, 6], [71, 5], [74, 5]], 8);
    const abc = writeAbc(t, makeKey(2, 'maj'));
    expect(abc.split('\n').pop()).toBe('A6 B2-| B3 d4- d|]');
    expect(played(abc)).toEqual([[69, 6], [71, 5], [74, 5]]);
  });

  it('writes a pickup before the first bar line', () => {
    const t = tune([[62, 1], [67, 3], [71, 3], [74, 6]], 6, 1, 0, '6/8');
    const abc = writeAbc(t, makeKey(7, 'maj'));
    expect(abc).toContain('M:6/8');
    expect(abc).toContain('Q:3/8=140');
    expect(abc.split('\n').pop()).toBe('D| G3 B3| d6|]');
  });

  it('beams a pickup as the bar it leads into would be (the review of 2026-11-28)', () => {
    // four quavers before a 6/8 bar: the first ends the previous beat, the three others a beat
    const jig = tune([[62, 1], [64, 1], [66, 1], [67, 1], [69, 6]], 6, 4, 0, '6/8');
    expect(writeAbc(jig, makeKey(7, 'maj')).split('\n').pop()).toBe('D EFG| A6|]');
    // five before a 4/4 bar
    const reel = tune([[62, 1], [64, 1], [66, 1], [67, 1], [69, 1], [71, 8]], 8, 5, 0);
    expect(writeAbc(reel, makeKey(2, 'maj')).split('\n').pop()).toBe('D EFGA| B8|]');
  });

  it('writes any metre: its M:, its Q: in its beat, its beams by its beats', () => {
    const seven = tune([[62, 1], [64, 1], [66, 1], [67, 1], [69, 1], [71, 1], [73, 1]], 7, 0, 0, '7/8');
    expect(writeAbc(seven, makeKey(2, 'maj')).split('\n')).toEqual(['M:7/8', 'L:1/8', 'Q:1/8=420', 'K:Dmaj', 'DE FG ABc|]']);
    const slipThree = tune([[62, 1], [64, 1], [66, 1]], 3, 0, 0, '3/8');
    expect(writeAbc(slipThree, makeKey(2, 'maj'))).toContain('Q:3/8=140');
    const cut = tune([[62, 1], [64, 1], [66, 1], [67, 1], [69, 1], [71, 1], [73, 1], [74, 1]], 8, 0, 0, 'C|');
    expect(writeAbc(cut, makeKey(2, 'maj')).split('\n')).toEqual(['M:C|', 'L:1/8', 'Q:1/2=105', 'K:Dmaj', 'DEFG ABcd|]']);
  });

  it('writes broken pairs, played dotted', () => {
    const t = tune([[71, 1], [72, 1], [74, 1], [71, 1], [72, 1], [71, 1], [69, 2]], 8);
    t.notes[0]!.broken = '>';
    t.notes[4]!.broken = '<';
    const abc = writeAbc(t, makeKey(9, 'min'));
    expect(abc.split('\n').pop()).toBe('B>cdB c<B A2|]');
    expect(played(abc)).toEqual([[71, 1.5], [72, 0.5], [74, 1], [71, 1], [72, 0.5], [71, 1.5], [69, 2]]);
  });

  it('writes the leading tone as a sharp, even under flats (Bédou: Ddor\'s C# was written Db)', () => {
    // a cadence on the tonic through its leading tone, in keys with flats and without
    const cadence = (tonic: number): Transcription => tune([[tonic + 7, 2], [tonic - 1, 2], [tonic, 4]], 8);
    expect(writeAbc(cadence(62), makeKey(2, 'min')).split('\n').pop()).toBe('A2 ^C2 D4|]');
    expect(writeAbc(cadence(62), makeKey(2, 'dor')).split('\n').pop()).toBe('A2 ^C2 D4|]');
    expect(writeAbc(cadence(67), makeKey(7, 'min')).split('\n').pop()).toBe('d2 ^F2 G4|]');
    expect(writeAbc(cadence(67), makeKey(7, 'dor')).split('\n').pop()).toBe('d2 ^F2 G4|]');
    expect(writeAbc(cadence(60), makeKey(0, 'min')).split('\n').pop()).toBe('G2 =B,2 C4|]');
    expect(writeAbc(cadence(69), makeKey(9, 'min')).split('\n').pop()).toBe('e2 ^G2 A4|]');
    // a 3rd, 6th or 7th lowered as flats, a raised 4th or 3rd as sharps, whatever the signature
    expect(writeAbc(tune([[70, 2], [75, 2], [77, 2], [73, 2]], 8), makeKey(7, 'maj')).split('\n').pop()).toBe('_B2 _e2 =f2 ^c2|]');
    expect(writeAbc(tune([[66, 2], [66, 2], [64, 4]], 8), makeKey(0, 'min')).split('\n').pop()).toBe('^F2 F2 =E4|]');
    expect(writeAbc(tune([[66, 4], [62, 4]], 8), makeKey(2, 'min')).split('\n').pop()).toBe('^F4 D4|]');
    // a semitone above the tonic by the older rule: in F major, a Db stays a flat
    expect(writeAbc(tune([[61, 2], [62, 2]], 8), makeKey(5, 'maj')).split('\n').pop()).toBe('_D2 =D2|]');
    for (const [t, k] of [[62, makeKey(2, 'min')], [67, makeKey(7, 'dor')], [60, makeKey(0, 'min')]] as const) {
      expect(played(writeAbc(cadence(t), k))).toEqual([[t + 7, 2], [t - 1, 2], [t, 4]]);
    }
  });

  it('writes a silence of a crotchet or more as a rest', () => {
    const notes: GridNote[] = [{ pitch: 62, at: 0, quavers: 4, sounds: 1 }, { pitch: 64, at: 4, quavers: 2, sounds: 1 }, { pitch: 66, at: 6, quavers: 2, sounds: 2 }];
    const t: Transcription = { notes, bars: [true, false, false, false, false, false, false, false, true], grid: [], metre: '4/4', rate: 7 };
    expect(writeAbc(t, makeKey(2, 'maj')).split('\n').pop()).toBe('D z3 E2 F2|]');
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

describe('parseMetre: any metre as M: writes it', () => {
  it('reads beats in quavers, the compound ones in threes', () => {
    expect(parseMetre('4/4')).toMatchObject({ bar: 8, beats: [2, 2, 2, 2], unit: 4 });
    expect(parseMetre('C')).toMatchObject({ text: 'C', bar: 8, beats: [2, 2, 2, 2] });
    expect(parseMetre('C|')).toMatchObject({ text: 'C|', bar: 8, beats: [4, 4], unit: 2 });
    expect(parseMetre('3/2')).toMatchObject({ bar: 12, beats: [4, 4, 4] });
    expect(parseMetre('12/8')).toMatchObject({ bar: 12, beats: [3, 3, 3, 3] });
    expect(parseMetre('5/8')).toMatchObject({ bar: 5, beats: [2, 3] });
    expect(parseMetre('7/8')).toMatchObject({ bar: 7, beats: [2, 2, 3] });
    expect(parseMetre(' 3+2+2/8 ')).toMatchObject({ text: '3+2+2/8', bar: 7, beats: [3, 2, 2] });
  });
  it('refuses what the quaver grid cannot hold', () => {
    for (const m of ['', 'abc', '4/3', '7/16', '1/8', '17/4', '0/4', '4/']) expect(parseMetre(m)).toBeNull();
  });
});

describe('modeOn: the mode of a tonic given, from the notes', () => {
  it('takes the scale that holds them, the heard mode breaking a tie', () => {
    const dMajor = [62, 64, 66, 67, 69, 71, 73, 74];
    expect(modeOn(dMajor, 2)).toBe('maj');
    expect(modeOn([62, 64, 65, 67, 69, 71, 72], 2)).toBe('dor');
    // no 7th: major and mixolydian hold as many — the heard one, else major
    expect(modeOn([62, 64, 66, 67, 69, 71], 2)).toBe('maj');
    expect(modeOn([62, 64, 66, 67, 69, 71], 2, 'mix')).toBe('mix');
  });
});
