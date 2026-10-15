import { describe, it, expect } from 'vitest';
import abcjs from 'abcjs';
import { tappedNote, tapTracks, secondsPerWhole, tapPlaysNote, TAP_MIN_SECONDS, TAP_MAX_SECONDS, TAP_GRACE_SECONDS } from './abcTapNote';

const SOURCE = 'X:1\nT:t\nM:6/8\nL:1/8\nQ:3/8=120\nK:D\n|:{g}A2B [DF]2 d|e3 z2 f:|\nf8|\n';
const at = (s: string) => SOURCE.indexOf(s);

/** As the viewer reads the text for a tap. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = (params: Record<string, unknown> = {}): any => {
  const tune = abcjs.parseOnly(SOURCE)[0]!;
  tune.setUpAudio(params);
  return tune;
};

describe('the note under a tap', () => {
  it('is the element the character belongs to', () => {
    expect(tappedNote(read(), at('B '))?.pitches.map(p => p.pitch)).toEqual([71]);
    expect(tappedNote(read(), at('d|'))?.pitches.map(p => p.pitch)).toEqual([74]);
  });

  it('holds every pitch of a chord', () => {
    expect(tappedNote(read(), at('[DF]') + 2)?.pitches.map(p => p.pitch)).toEqual([62, 66]);
  });

  it('carries its graces, from a tap on the grace itself too', () => {
    const note = tappedNote(read(), at('{g}') + 1);
    expect(note?.pitches.map(p => p.pitch)).toEqual([69]);
    expect(note?.graces?.map(g => g.pitch)).toEqual([79]);
  });

  it('is nothing on a rest, a bar line or a header', () => {
    expect(tappedNote(read(), at('z2'))).toBeNull();
    expect(tappedNote(read(), at('|e'))).toBeNull();
    expect(tappedNote(read(), at('K:D'))).toBeNull();
  });

  it('sounds in the key and on the instrument play uses', () => {
    const p = tappedNote(read({ program: 73, midiTranspose: 2 }), at('d|'))!.pitches[0]!;
    expect(p.pitch).toBe(76);
    expect(p.instrument).toBe(73);
  });
});

describe('what a tap plays', () => {
  const tune = read();
  const whole = secondsPerWhole(tune, 100);

  it('reads the written tempo, at the viewer speed', () => {
    // 6/8 at a dotted crotchet = 120: a bar is a second, a whole note 4/3 s.
    expect(whole).toBeCloseTo(4 / 3);
    expect(secondsPerWhole(tune, 50)).toBeCloseTo(8 / 3);
  });

  it('lasts long enough to hear, and never drags on', () => {
    const quaver = tapTracks(tappedNote(tune, at('B '))!.pitches, null, whole, undefined);
    expect(quaver[0]!.notes[0]!.seconds).toBe(TAP_MIN_SECONDS);
    const crotchet = tapTracks(tappedNote(tune, at('[DF]'))!.pitches, null, whole, undefined);
    expect(crotchet[0]!.notes[0]!.seconds).toBeCloseTo(1 / 3);
    const long = tapTracks(tappedNote(tune, at('f8'))!.pitches, null, whole, undefined);
    expect(long[0]!.notes[0]!.seconds).toBe(TAP_MAX_SECONDS);
  });

  it('puts a chord on a track per pitch, the graces before the first', () => {
    const chord = tapTracks(tappedNote(tune, at('[DF]'))!.pitches, null, whole, undefined);
    expect(chord.map(t => t.notes.map(n => n.pitch))).toEqual([[62], [66]]);
    const graced = tappedNote(tune, at('{g}'))!;
    const tracks = tapTracks(graced.pitches, graced.graces, whole, undefined);
    expect(tracks[0]!.notes.map(n => [n.pitch, n.seconds])).toEqual([[79, TAP_GRACE_SECONDS], [69, TAP_MIN_SECONDS]]);
  });

  it('is played on the instrument chosen in the viewer', () => {
    expect(tapTracks([{ pitch: 60, duration: 0.25, instrument: 0 }], null, 1, 22)[0]!.instrument).toBe(22);
    expect(tapTracks([{ pitch: 60, duration: 0.25, instrument: 5 }], null, 1, undefined)[0]!.instrument).toBe(5);
  });
});

describe('the setting', () => {
  it('is on unless turned off', () => {
    expect(tapPlaysNote({})).toBe(true);
    expect(tapPlaysNote({ abcTapPlaysNote: false })).toBe(false);
  });
});
