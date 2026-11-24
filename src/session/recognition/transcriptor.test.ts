import { describe, expect, it } from 'vitest';
import { transcribeNotes, asClassNotes, resample, RATE, type Note } from './transcriptor';

/** Harmonic tones (MIDI pitch, start s, length s): 6 partials falling as 1/h, a 5 ms attack,
 *  a 10 ms release, a little noise. */
function synth(notes: [number, number, number][], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let seed = 7;
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.002 * (seed / 0x7fffffff - 0.5); }
  for (const [pitch, start, length] of notes) {
    const f0 = 440 * 2 ** ((pitch - 69) / 12);
    const s = Math.round(start * RATE), n = Math.round(length * RATE);
    for (let i = 0; i < n && s + i < out.length; i++) {
      const t = i / RATE;
      const env = Math.min(1, t / 0.005, (length - t) / 0.01);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h;
      out[s + i] += 0.2 * env * v;
    }
  }
  return out;
}

const classesOf = (notes: Note[]) => notes.map(n => n.cls);

describe('transcribeNotes', () => {
  it('hears a scale in quavers, each onset within 15 ms', () => {
    // D major from D4, quavers at 120 crotchets a minute, after half a second of quiet
    const pitches = [62, 64, 66, 67, 69, 71, 73, 74];
    const tune = pitches.map((p, k): [number, number, number] => [p, 0.5 + 0.25 * k, 0.25]);
    const notes = transcribeNotes(synth(tune, 3), RATE);
    expect(classesOf(notes)).toEqual(pitches.map(p => p % 12));
    notes.forEach((n, k) => expect(Math.abs(n.onset - tune[k]![1])).toBeLessThan(0.015));
  });

  it('hears a repeated note played detached (60 ms apart)', () => {
    // re-attacked with no silence, a repeated note is split later, on the grid
    // (transcription.ts's splitRepeats)
    const tune: [number, number, number][] = [[69, 0.5, 0.24], [69, 0.8, 0.24], [69, 1.1, 0.24], [71, 1.4, 0.4]];
    const notes = transcribeNotes(synth(tune, 2.4), RATE);
    expect(classesOf(notes)).toEqual([9, 9, 9, 11]);
    notes.forEach((n, k) => expect(Math.abs(n.onset - tune[k]![1])).toBeLessThan(0.02));
  });

  it('hears a short note between two long ones', () => {
    const tune: [number, number, number][] = [[67, 0.5, 0.5], [69, 1.0, 0.06], [71, 1.06, 0.5]];
    const notes = transcribeNotes(synth(tune, 2), RATE);
    expect(classesOf(notes)).toEqual([7, 9, 11]);
  });

  it('puts each note at its octave in the octave profile', () => {
    const notes = transcribeNotes(synth([[57, 0.5, 0.5], [76, 1.0, 0.5]], 2), RATE);
    const loudest = (n: Note) => n.octaves.indexOf(Math.max(...n.octaves));
    // A3 = 48 + 9 + 12 x 0, E5 = 48 + 4 + 12 x 2
    expect(notes.map(loudest)).toEqual([0, 2]);
  });
});

describe('resample', () => {
  it('brings a sine to another rate, same frequency, same length in time', () => {
    const from = 44100, f = 440, x = Float32Array.from({ length: from }, (_, i) => Math.sin((2 * Math.PI * f * i) / from));
    const y = resample(x, from, RATE);
    expect(y.length).toBe(RATE);
    for (const i of [1000, 20000, 40000]) expect(Math.abs(y[i]! - Math.sin((2 * Math.PI * f * i) / RATE))).toBeLessThan(0.01);
    expect(resample(x, from, from)).toBe(x);
  });

  it('hears the same notes in a recording at 44.1 kHz brought to 48 kHz', () => {
    const pitches = [62, 64, 66, 67, 69, 71, 73, 74];
    const at = (rate: number) => {
      const out = new Float32Array(Math.round(3 * rate));
      pitches.forEach((p, k) => {
        const f0 = 440 * 2 ** ((p - 69) / 12), s = Math.round((0.5 + 0.25 * k) * rate), n = Math.round(0.25 * rate);
        for (let i = 0; i < n; i++) { const t = i / rate, env = Math.min(1, t / 0.005, (0.25 - t) / 0.01); let v = 0; for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h; out[s + i]! += 0.2 * env * v; }
      });
      return out;
    };
    const notes = transcribeNotes(resample(at(44100), 44100), RATE);
    expect(notes.map(n => n.cls)).toEqual(pitches.map(p => p % 12));
  });
});

describe('asClassNotes', () => {
  it('writes 8 values a note at the given frame rate', () => {
    const note: Note = { cls: 2, onset: 1, offset: 1.5, power: 0.3, octaves: [1, 2, 3, 4] };
    expect(Array.from(asClassNotes([note], 10))).toEqual([2, 10, 5, Math.fround(0.3), 1, 2, 3, 4]);
  });
});
