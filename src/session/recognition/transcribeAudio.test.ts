import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import init from '../../../vendor/folkfriend/folkfriend.js';
import { transcribeAudio, type TranscribeSettings } from './transcribeAudio';

// The transcription end to end, in Node, on scenes whose truth is known: tunes written
// here in a little ABC (explicit accidentals, no key signature), played by harmonic tones whose
// accents follow the metre (players lean on the bar's first note, then on its beats) over a
// little noise, a few times over as a tune is. Each test is one of the testers' remarks
// (WhatsApp « Projet Baloche », 23-25 Nov. 2026); `it.fails` marks what the transcription
// cannot do yet — such a test turning green says the limit is gone.

const RATE = 48000;

/** A tune in a little ABC: notes C, (MIDI 60) to b' with ^ _ = and a length in quavers
 *  (L:1/8), z a rest; bar lines and spaces ignored. */
function parse(abc: string): [number | null, number][] {
  const out: [number | null, number][] = [];
  const re = /([_^=]?)([A-Ga-gz])([,']*)(\d*)/g;
  const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let m: RegExpExecArray | null;
  while ((m = re.exec(abc))) {
    const len = m[4] ? Number(m[4]) : 1;
    if (m[2] === 'z') { out.push([null, len]); continue; }
    const up = m[2] === m[2]!.toLowerCase();
    let p = 60 + STEP[m[2]!.toUpperCase()]! + (up ? 12 : 0) + (m[1] === '^' ? 1 : m[1] === '_' ? -1 : 0);
    for (const c of m[3]!) p += c === "'" ? 12 : -12;
    out.push([p, len]);
  }
  return out;
}

/** `abc` played `times` times at `quaversPerS`, bars of `bar` quavers, beats of `beat`. */
function play(abc: string, { quaversPerS, bar, beat, times = 3 }: { quaversPerS: number; bar: number; beat: number; times?: number }): Float32Array {
  const notes = parse(abc);
  const total = notes.reduce((s, [, l]) => s + l, 0) * times;
  const out = new Float32Array(Math.ceil((total / quaversPerS + 1) * RATE));
  let seed = 7;
  for (let i = 0; i < out.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out[i] = 0.002 * (seed / 0x7fffffff - 0.5); }
  let q = 0;
  for (let k = 0; k < times; k++) {
    for (const [pitch, len] of notes) {
      const t = 0.3 + q / quaversPerS, d = len / quaversPerS;
      const accent = q % bar === 0 ? 1 : q % beat === 0 ? 0.7 : 0.45;
      q += len;
      if (pitch === null) continue;
      const f0 = 440 * 2 ** ((pitch - 69) / 12), s = Math.round(t * RATE), n = Math.round(d * RATE);
      for (let j = 0; j < n && s + j < out.length; j++) {
        const x = j / RATE, env = Math.min(1, x / 0.006, (d - x) / 0.015) * (0.75 + 0.25 * Math.exp(-x / 0.08));
        let v = 0;
        for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * h * f0 * x) / h;
        out[s + j] += 0.2 * accent * env * v;
      }
    }
  }
  return out;
}

const lines = (abc: string | null) => abc?.split('\n') ?? [];
const header = (abc: string | null, field: string) => lines(abc).find(l => l.startsWith(`${field}:`))?.slice(field.length + 1);
const body = (abc: string | null) => lines(abc).filter(l => !/^[A-Z]:/.test(l)).join(' ');

const scenes = {
  reel: { abc: 'D2^FA dA^FA | BEED B,EED | D2^FA dA^FA | B^cde ^fdd2 | ^f2a^f g^feg | ^fde^c d2BA | B2e^c dBA^F | GBA^F EDD2', quaversPerS: 8, bar: 8, beat: 2 },
  jig: { abc: 'G2B dBG | A2B cBA | G2B dBG | ^FAG ^FED | G2B dBG | A2B c2e | dBG ^FAd | G3 G3', quaversPerS: 7, bar: 6, beat: 3 },
  slowJig: { abc: 'G2B dBG | A2B cBA | G2B dBG | ^FAG ^FED | G2B dBG | A2B c2e | dBG ^FAd | G3 G3', quaversPerS: 4, bar: 6, beat: 3 },
  dorianWithLeadingTone: { abc: 'D2FA d2A2 | B2AG F2E2 | D2FA d2^c2 | d4 A4 | B2d2 A2F2 | G2E2 F2D2 | E2^C2 D2E2 | D8', quaversPerS: 6, bar: 8, beat: 2 },
  // Antton's tune (25-11): a part in G minor, then one in G major
  keyChange: { abc: 'G2 _B2 d2 _B2 | c2 A2 _B2 G2 | ^F2 A2 c2 A2 | G8 | G2 _B2 d2 _B2 | c2 _e2 d2 c2 | _B2 A2 ^F2 A2 | G8 | B2 d2 g2 d2 | e2 c2 d2 B2 | A2 ^F2 A2 c2 | B8 | B2 d2 g2 d2 | e2 c2 A2 ^F2 | G2 B2 A2 ^F2 | G8', quaversPerS: 6, bar: 8, beat: 2, times: 2 },
  polka: { abc: 'A2 ^FA | d2 d^c | B2 GB | A2 ^FA | A2 ^FA | d2 d^c | B2 ^cB | A4 | d2 ^fd | e2 ^ce | d2 BG | A2 ^FA | d2 ^fd | e2 ^ce | d2 ^c2 | d4', quaversPerS: 7, bar: 4, beat: 2 },
  waltz: { abc: 'A4 cB | A2 E2 C2 | D4 FE | D6 | E4 GF | E2 C2 A,2 | B,2 C2 D2 | C6 | A4 cB | A2 E2 C2 | D4 FE | D6 | E4 ^GF | E2 B,2 ^G,2 | A,6 | A,6', quaversPerS: 5, bar: 6, beat: 2 },
  // Antton's waltz in five (Valse5T.zip), its first part as written
  fiveTime: { abc: 'c2c BG | F2E DC | c2c BG | F2E DC | E2E DE | C2C A,C | D2D CD | D5', quaversPerS: 5, bar: 5, beat: 5 },
} as const;

beforeAll(async () => {
  await init(readFileSync(resolve(__dirname, '../../../vendor/folkfriend/folkfriend_bg_simd.wasm')));
});

/** Each scene transcribed once. */
const heard = new Map<string, string | null>();
function transcribed(name: keyof typeof scenes): string | null {
  if (!heard.has(name)) heard.set(name, transcribeAudio(play(scenes[name].abc, scenes[name]), RATE));
  return heard.get(name)!;
}
const T = 120000;

describe('transcribeAudio: what it writes right', () => {
  it('a jig: 6/8, G major, its notes and bars', () => {
    const abc = transcribed('jig');
    expect(header(abc, 'M')).toBe('6/8');
    expect(header(abc, 'K')).toBe('Gmaj');
    expect(body(abc)).toContain('G2 B dBG| A2 B cBA| G2 B dBG| FAG FED|');
  }, T);

  it('a slow jig is not written at double length (Bédou, 25-11)', () => {
    const abc = transcribed('slowJig');
    expect(header(abc, 'M')).toBe('6/8');
    expect(header(abc, 'Q')).toBe('3/8=80');
    expect(body(abc)).toContain('G2 B dBG| A2 B cBA|');
  }, T);

  it('a reel: 4/4 in D major', () => {
    const abc = transcribed('reel');
    expect(header(abc, 'M')).toBe('4/4');
    expect(header(abc, 'K')).toBe('Dmaj');
  }, T);

  it('D dorian with its leading tone: Ddor, the C# written sharp (Bédou, 25-11)', () => {
    const abc = transcribed('dorianWithLeadingTone');
    expect(header(abc, 'K')).toBe('Ddor');
    expect(body(abc)).toContain('d2 ^c2| d4 A4|');
    expect(body(abc)).toContain('E2 ^C2 D2 E2|');
    expect(body(abc)).not.toMatch(/_D|_d/);
  }, T);
});

describe('transcribeAudio: borrowed notes', () => {
  it('a G minor part under one G major key: its Bb and Eb written flat (Antton, 25-11)', () => {
    const b = body(transcribed('keyChange'));
    expect(b).toContain('G2 _B2 d2 B2|');
    expect(b).not.toMatch(/\^A|\^d/);
  }, T);
});

describe('transcribeAudio: what the user said of the recording (the Transcription module)', () => {
  const given = (name: keyof typeof scenes, settings: TranscribeSettings) => transcribeAudio(play(scenes[name].abc, scenes[name]), RATE, () => {}, settings);
  const barLengths = (abc: string | null) => body(abc).split('|').slice(1, -2).map(bar => bar.trim()).filter(Boolean);

  it('a polka said to be in 2/4: written in 2/4, its bars of two crotchets', () => {
    const abc = given('polka', { metre: '2/4' });
    expect(header(abc, 'M')).toBe('2/4');
    expect(header(abc, 'Q')).toMatch(/^1\/4=/);
    expect(barLengths(abc).length).toBeGreaterThan(20);
  }, T);

  it('a waltz said to be in 3/4: written in 3/4', () => {
    const abc = given('waltz', { metre: '3/4' });
    expect(header(abc, 'M')).toBe('3/4');
    expect(body(abc)).toMatch(/A6|D6|C6/);
  }, T);

  it('a key given: written in it, its accidentals by its degrees', () => {
    const abc = given('reel', { key: { tonic: 2, mode: 'mix' } });
    expect(header(abc, 'K')).toBe('Dmix');
    expect(body(abc)).toContain('^c');
  }, T);

  it('any metre M: writes (2026-11-28): a tune in five said to be in 5/4, one in 7/8', () => {
    const five = given('fiveTime', { metre: '5/4' });
    expect(header(five, 'M')).toBe('5/4');
    expect(header(five, 'Q')).toMatch(/^1\/4=/);
    const seven = given('polka', { metre: '2+2+3/8' });
    expect(header(seven, 'M')).toBe('2+2+3/8');
    expect(header(seven, 'Q')).toMatch(/^1\/8=/);
    // what cannot be laid out is as nothing said: told from the recording
    expect(header(given('reel', { metre: '7/16' }), 'M')).toMatch(/^(4\/4|6\/8)$/);
  }, T);

  it('a tonic given, its mode not (2026-11-28): the mode whose scale holds the notes', () => {
    expect(header(given('reel', { key: { tonic: 2 } }), 'K')).toBe('Dmaj');
    expect(header(given('dorianWithLeadingTone', { key: { tonic: 2 } }), 'K')).toBe('Ddor');
    // on another tonic than the one heard, the notes alone decide: E with D major's notes
    expect(header(given('reel', { key: { tonic: 4 } }), 'K')).toBe('Edor');
  }, T);
});

describe('transcribeAudio: what it cannot do yet', () => {
  // told from the recording, the metre is binary (4/4) or ternary (6/8), nothing else: the
  // others are the user's to give (transcription.ts, Metre)
  it.fails('a polka in 2/4 (Bédou, 25-11)', () => {
    expect(header(transcribed('polka'), 'M')).toBe('2/4');
  }, T);
  it.fails('a waltz in 3/4 (Bédou, 25-11)', () => {
    expect(header(transcribed('waltz'), 'M')).toBe('3/4');
  }, T);
  it.fails('a waltz in five (Antton, 25-11)', () => {
    expect(header(transcribed('fiveTime'), 'M')).toMatch(/^5\//);
  }, T);
  // one K: for the whole tune: the G minor part comes out in G major, its Bb written A#
  it.fails('a change of key within the tune (Antton, 25-11)', () => {
    expect(lines(transcribed('keyChange')).filter(l => /^K:|\[K:/.test(l)).length).toBeGreaterThanOrEqual(2);
  }, T);
  // a note played again, re-attacked, merged into one (Bédou's double notes in The Kesh, 23-11)
  it.fails('repeated notes, each with its attack', () => {
    expect(body(transcribed('reel'))).toContain('B,EED');
  }, T);
  // the bars' phase from the accents: half a bar out on the reel, whose first note is the
  // most accented (bars on a downbeat: 56 % on the session extracts)
  it.fails('bar lines on the accented downbeats', () => {
    expect(body(transcribed('reel')).startsWith('D2 FA dAFA|')).toBe(true);
  }, T);
});
