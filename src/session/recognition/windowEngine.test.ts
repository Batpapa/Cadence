import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import init, { FolkFriendWASM } from '../../../vendor/folkfriend/folkfriend.js';
import { configureForQuery, TuneQuery } from './folkfriendQuery';
import { FolkFriendEngine } from './folkfriendEngine';
import { TranscriptorEngine } from './transcriptorEngine';
import { PlayedPitch } from './playedPitch';
import type { WindowEngine } from './windowEngine';

// Both recognition engines end to end, in Node, as the worker drives them: FolkFriend's module,
// an index of the sample settings (test-fixtures/abc-contour-index-sample.json), a window of
// one of them played by harmonic tones — the tune must come first. Guards the comparison
// engine as much as the default one: neither runs anywhere else in the tests.

const RATE = 48000;
const CONTOUR_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUV';
const sample = JSON.parse(readFileSync(resolve(__dirname, '../../../test-fixtures/abc-contour-index-sample.json'), 'utf8')) as Record<string, { meter: string; mode: string; contour: string }>;

/** A 10 s window of the setting's contour (one symbol a quaver of `q` s; a symbol repeated is a
 *  longer note), harmonic tones over a little noise. */
function play(contour: string, q = 0.13, seconds = 10): Float32Array {
  const out = new Float32Array(seconds * RATE);
  let seed = 11;
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.002 * (seed / 0x7fffffff - 0.5); }
  let t = 0.2;
  for (let i = 0; i < contour.length && t < seconds; ) {
    let j = i;
    while (j < contour.length && contour[j] === contour[i]) j++;
    const pitch = 48 + CONTOUR_CHARS.indexOf(contour[i]!), length = (j - i) * q;
    const f0 = 440 * 2 ** ((pitch - 69) / 12), s = Math.round(t * RATE), n = Math.round(length * RATE);
    for (let k = 0; k < n && s + k < out.length; k++) {
      const x = k / RATE, env = Math.min(1, x / 0.005, (length - x) / 0.01);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * x) / h;
      out[s + k] += 0.2 * env * v;
    }
    t += length; i = j;
  }
  return out;
}

let query: TuneQuery;
let ff: FolkFriendWASM;

beforeAll(async () => {
  await init(readFileSync(resolve(__dirname, '../../../vendor/folkfriend/folkfriend_bg_simd.wasm')));
  ff = new FolkFriendWASM();
  ff.set_sample_rate(RATE);
  configureForQuery(ff);
  const settings: Record<string, unknown> = {}, aliases: Record<string, string[]> = {};
  for (const [id, s] of Object.entries(sample)) {
    settings[id] = { tune_id: id, meter: s.meter, mode: s.mode, abc: '', dance: 'reel', contour: s.contour };
    aliases[id] = [`tune ${id}`];
  }
  ff.load_index_from_json_obj({ settings, aliases });
  const pp = new PlayedPitch(t => {
    const raw = JSON.parse(ff.settings_from_tune_id(t)) as Array<[string, { contour: string }]> | { error: string };
    return Array.isArray(raw) ? raw.map(([id, s]) => [id, s.contour] as [string, string]) : [];
  });
  query = new TuneQuery(ff, pp);
});

const TUNES = ['1', '39'];

describe.each([
  ['transcriptor', () => new TranscriptorEngine(RATE, query) as WindowEngine],
  ['folkfriend', () => new FolkFriendEngine(ff, query) as WindowEngine],
])('the %s engine', (_name, make) => {
  it.each(TUNES)('names tune %s first in a window of it', id => {
    const engine = make();
    const { result } = engine.analyze(play(sample[id]!.contour), 0, 10);
    expect(result.empty).toBe(false);
    expect(result.candidates[0]!.tuneId).toBe(id);
    expect(result.tWindowStart).toBe(0);
    expect(result.tWindowEnd).toBe(10);
  });

  it('hears nothing to name in silence', () => {
    const { result } = make().analyze(new Float32Array(10 * RATE), 0, 10);
    expect(result.empty).toBe(true);
    expect(result.candidates).toEqual([]);
  });
});
