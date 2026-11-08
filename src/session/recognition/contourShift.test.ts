import { describe, expect, it } from 'vitest';
import { pitchClassesForDisplay } from './contourShift';

describe('pitchClassesForDisplay', () => {
  it('places the classes from D4 up to C#5', () => {
    // D (c) -> MIDI 62 = 'o', C# (b) -> MIDI 73 = 'z', C (a) -> MIDI 72 = 'y'
    expect(pitchClassesForDisplay('cba')).toBe('ozy');
  });

  it('keeps the melody, one symbol per class', () => {
    expect(pitchClassesForDisplay('cegc').length).toBe(4);
  });
});
