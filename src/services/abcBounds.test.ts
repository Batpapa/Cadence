import { describe, it, expect } from 'vitest';
import abcjs from 'abcjs';
import { shiftPosition, boundNote, notesAcross, regionOf, setBound } from './abcBounds';
import { notesOf } from './abcTextPlayback';

const SOURCE = 'X:1\nM:6/8\nL:1/8\nK:D\n|:A2B c2d|e3 z2 f:|\n';
const at = (s: string) => SOURCE.indexOf(s);
const notes = notesOf(abcjs.parseOnly(SOURCE)[0]);

describe('a bound while typing', () => {
  const text = 'A2B c2d|';
  it('moves along with what is typed before its note', () => {
    expect(shiftPosition(4, text, 'FA2B c2d|')).toBe(5);
    // Right in front of the note: the note moved on, so does the bound.
    expect(shiftPosition(4, text, 'A2B Fc2d|')).toBe(5);
    expect(shiftPosition(4, text, '2B c2d|')).toBe(3);
  });

  it('stays put for what is typed after it', () => {
    expect(shiftPosition(4, text, 'A2B c2d|e')).toBe(4);
    expect(shiftPosition(4, text, 'A2B c3d|')).toBe(4);
  });

  it('goes with its note when the note itself is rewritten', () => {
    expect(shiftPosition(4, text, 'A2B e2d|')).toBeNull();
    expect(shiftPosition(4, text, 'A2B 2d|')).toBeNull();
  });
});

describe('the note a bound names', () => {
  it('is the one its position is in', () => {
    expect(boundNote(notes, at('c2'), 'in')).toEqual({ start: at('c2'), end: at('d|') });
    expect(boundNote(notes, at('c2') + 1, 'out')?.start).toBe(at('c2'));
  });

  it('narrows the passage when the position fell off a note', () => {
    // On the bar line between d and e.
    expect(boundNote(notes, at('|e'), 'in')?.start).toBe(at('e3'));
    expect(boundNote(notes, at('|e'), 'out')?.start).toBe(at('d|'));
  });
});

describe('the passage', () => {
  it('is nothing with no bound', () => {
    expect(regionOf(notes, null, null)).toBeNull();
  });

  it('runs from the start note to the end of the end note, both included', () => {
    const r = regionOf(notes, at('B '), at('d|'))!;
    expect(r.from).toBe(at('B '));
    expect(r.to).toBe(at('|e'));
  });

  it('is the tune start or end where a bound is missing', () => {
    expect(regionOf(notes, at('e3'), null)).toMatchObject({ from: at('e3'), to: Infinity });
    expect(regionOf(notes, null, at('B '))).toMatchObject({ from: 0, to: at('c2') });
  });

  it('takes a selection to its first and last note', () => {
    const across = notesAcross(notes, at('B '), at('e3') + 1)!;
    expect(across.first.start).toBe(at('B '));
    expect(across.last.start).toBe(at('e3'));
    expect(notesAcross(notes, at('|e'), at('|e') + 1)).toBeNull();
  });
});

describe('setting a bound', () => {
  it('keeps the other one when they stay in order', () => {
    expect(setBound({ in: 2, out: 10 }, 'in', 5)).toEqual({ in: 5, out: 10 });
    expect(setBound({ in: 2, out: 10 }, 'out', 5)).toEqual({ in: 2, out: 5 });
  });

  it('drops the other one when it would come the wrong side', () => {
    expect(setBound({ in: 2, out: 10 }, 'in', 12)).toEqual({ in: 12, out: null });
    expect(setBound({ in: 8, out: 10 }, 'out', 5)).toEqual({ in: null, out: 5 });
  });

  it('allows a single note for both', () => {
    expect(setBound({ in: 5, out: null }, 'out', 5)).toEqual({ in: 5, out: 5 });
  });

  it('clears the start when set at the tune start', () => {
    expect(setBound({ in: 5, out: 10 }, 'in', null)).toEqual({ in: null, out: 10 });
  });
});
