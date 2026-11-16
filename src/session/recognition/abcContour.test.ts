import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { abcContour, abcToMidi, builderAbc, midiContour } from './abcContour';

// test-fixtures/abc-contour-index-sample.json: settings of the live recognition
// index (2026-11-09), their ABC and the contour FolkFriend's builder gave them —
// every meter, plus rolls, grace notes, triplets, endings, chords, a 2/4 polka
// (the builder's L:1/8) and 14639, whose lines end on a roll (abc2midi reads
// memory it never set there; the WebAssembly build reads what the index has).
const sample = JSON.parse(readFileSync(nodePath.resolve(__dirname, '../../../test-fixtures/abc-contour-index-sample.json'), 'utf8')) as
  Record<string, { meter: string; mode: string; abc: string; contour: string }>;
const abc2midi = new WebAssembly.Module(readFileSync(nodePath.resolve(__dirname, '../../../vendor/abc2midi/abc2midi.wasm')));

describe('abcContour', () => {
  it.each(Object.entries(sample))('gives setting %s the index contour', (_id, s) => {
    expect(abcContour(abc2midi, builderAbc(s))).toBe(s.contour);
  });

  it('takes a whole ABC file as the builder takes a setting', () => {
    const s = sample['1']!;
    const file = ['X: 1', 'T: The Kesh', 'R: reel', `M: ${s.meter}`, 'L: 1/8', `K: ${s.mode}`, s.abc.replace(/\r/g, '')].join('\n');
    expect(abcContour(abc2midi, file)).toBe(s.contour);
  });

  it('runs again in a fresh instance', () => {
    const s = sample['5']!;
    const first = abcContour(abc2midi, builderAbc(s));
    expect(abcContour(abc2midi, builderAbc(s))).toBe(first);
  });

  it('gives nothing for text that is not music', () => {
    expect(abcContour(abc2midi, 'hello')).toBeNull();
  });
});

describe('midiContour', () => {
  /** A format-0 file of the given (pitch, start, end) notes, 480 ticks a crotchet. */
  const midiOf = (notes: [number, number, number][]): Uint8Array => {
    const events = notes.flatMap(([p, s, e]) => [[s, 0x90, p, 80], [e, 0x80, p, 0]]).sort((a, b) => a[0]! - b[0]!);
    const body: number[] = [];
    let t = 0;
    for (const [time, status, p, v] of events) {
      let d = time! - t; t = time!;
      const bytes = [d & 0x7f]; while ((d >>= 7)) bytes.unshift((d & 0x7f) | 0x80);
      body.push(...bytes, status!, p!, v!);
    }
    body.push(0, 0xff, 0x2f, 0);
    const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, 0x01, 0xe0, 0x4d, 0x54, 0x72, 0x6b, ...u32(body.length), ...body]);
  };

  it('repeats a note once per quaver', () => {
    // D5 a crotchet, E5 a quaver: 74 -> 'A', 76 -> 'C'
    expect(midiContour(midiOf([[74, 0, 480], [76, 480, 720]]))).toBe('AAC');
  });

  it('gives a short note a quaver and skips what follows until the music catches up', () => {
    // two semiquavers then a quaver: the second semiquaver is dropped
    expect(midiContour(midiOf([[74, 0, 120], [76, 120, 240], [77, 240, 480]]))).toBe('AD');
  });

  it('folds pitches into range with strict bounds', () => {
    // MIDI 48 and 95 are out (rel_pitch's <= / >=): an octave in
    expect(midiContour(midiOf([[48, 0, 240], [95, 240, 480]]))).toBe('mJ');
  });

  it('reads abc2midi\'s own output', () => {
    expect(abcToMidi(abc2midi, 'X:1\nT:\nM:4/4\nL:1/8\nK:D\nd2e|')).not.toBeNull();
  });
});
