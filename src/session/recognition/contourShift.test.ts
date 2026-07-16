import { describe, expect, it } from 'vitest';
import { shiftContour } from './contourShift';

describe('shiftContour', () => {
  it('shifts one octave up within range', () => {
    expect(shiftContour('abc', 12)).toBe('mno');
  });

  it('crosses the lowercase/uppercase boundary', () => {
    // u=20 → 32='G', z=25 → 37='L'
    expect(shiftContour('uz', 12)).toBe('GL');
  });

  it('drops notes that leave the range instead of clamping', () => {
    expect(shiftContour('aV', 12)).toBe('m'); // V is the top of the range
    expect(shiftContour('a', -12)).toBe('');
  });

  it('drops unexpected characters', () => {
    expect(shiftContour('a?b', 12)).toBe('mn');
  });

  it('keeps an empty contour empty', () => {
    expect(shiftContour('', 12)).toBe('');
  });
});
