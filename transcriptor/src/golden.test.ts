import { describe, expect, it } from 'vitest';
import { transcribeNotes, RATE } from './decoder.ts';
import { recognitionContour } from './recognition.ts';
import { goldenSignal } from './golden.ts';

// What the decoder hears in a fixed signal (golden.ts: a line, the same an octave down, a drone,
// noise), frozen. Not a measure of quality — the benches are — but a tripwire: any change to the
// analysis, the salience, the decoding or the contour that alters what is heard fails here, and
// is then either a mistake or a decision to write down. The TypeScript analysis (the WebAssembly
// one is checked against it in Cadence's transcriptorInit.test.ts).

describe('the reference signal', () => {
  const pcm = goldenSignal();

  it('is heard as the same notes', () => {
    const notes = transcribeNotes(pcm, RATE);
    expect(notes.map(n => n.cls)).toEqual([3, 2, 9, 6, 9, 2, 4, 6, 4, 2, 11, 9, 6, 4, 6, 9, 11, 9, 2, 9, 6, 9, 11, 1,
      2, 9, 6, 9, 2, 4, 6, 4, 2, 11, 9, 6, 4, 6, 9, 11, 9, 2, 9, 6, 9, 11, 1, 2, 4]);
    expect(notes.slice(0, 8).map(n => +n.onset.toFixed(3))).toEqual([0.011, 0.197, 0.443, 0.581, 0.72, 0.864, 1.003, 1.141]);
  });

  it('gives the recogniser the same query and the same second opinion', () => {
    const r = recognitionContour(pcm, RATE);
    expect(r.contour).toBe('cjgjcegecljgegjljjcjgjlbcjgjcegecljgegjljjcjgjlbcc');
    expect(r.opinions).toEqual(['cjgjcegecljgegjljjcjgjlbcjgjcegecljgegjljjcjgjlbcc']);
    expect(r.tuning).toBeCloseTo(-0.0073, 3);
  });
});
