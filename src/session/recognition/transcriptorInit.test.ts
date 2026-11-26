import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import init from '../../../vendor/cadence-transcriptor/cadence_transcriptor.js';
import { transcribeNotes, useAnalysis } from '../../../transcriptor/src/decoder.ts';
import { nativeAnalyse } from './transcriptorInit';

const RATE = 48000;

/** A tune of harmonic tones with a little noise (as transcriptor/src/transcriptor.test.ts). */
function synth(notes: [number, number, number][], seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let seed = 3;
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.002 * (seed / 0x7fffffff - 0.5); }
  for (const [pitch, start, length] of notes) {
    const f0 = 440 * 2 ** ((pitch - 69) / 12);
    const s = Math.round(start * RATE), n = Math.round(length * RATE);
    for (let i = 0; i < n && s + i < out.length; i++) {
      const t = i / RATE, env = Math.min(1, t / 0.005, (length - t) / 0.01);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * t) / h;
      out[s + i] += 0.2 * env * v;
    }
  }
  return out;
}

describe('the WebAssembly analysis', () => {
  it('leads to the notes the TypeScript one does', async () => {
    const pitches = [62, 66, 69, 74, 71, 67, 64, 62, 69, 76, 74, 73];
    const pcm = synth(pitches.map((p, k): [number, number, number] => [p, 0.4 + 0.2 * k, 0.2]), 3.4);
    const ts = transcribeNotes(pcm, RATE);
    await init(readFileSync(resolve(__dirname, '../../../vendor/cadence-transcriptor/cadence_transcriptor_bg_simd.wasm')));
    useAnalysis(nativeAnalyse);
    const wasm = transcribeNotes(pcm, RATE);
    expect(wasm.map(n => n.cls)).toEqual(ts.map(n => n.cls));
    wasm.forEach((n, k) => expect(Math.abs(n.onset - ts[k]!.onset)).toBeLessThan(0.002));
    expect(ts.map(n => n.cls)).toEqual(pitches.map(p => p % 12));
  });
});
