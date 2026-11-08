import { describe, expect, it } from 'vitest';
import { transposeMode } from './keyName';

describe('transposeMode', () => {
  it('leaves a key as written when nothing moves', () => {
    expect(transposeMode('Dmajor', 0)).toBe('Dmajor');
    expect(transposeMode('Dmajor', 12)).toBe('Dmajor');
  });

  it('moves the tonic and keeps the mode', () => {
    expect(transposeMode('Dmajor', 2)).toBe('Emajor');
    expect(transposeMode('Gmajor', -2)).toBe('Fmajor');
    expect(transposeMode('Edorian', 2)).toBe('F#dorian');
    expect(transposeMode('Ador', 0)).toBe('Ador');
  });

  it('spells with the fewest accidentals for the mode', () => {
    expect(transposeMode('Amajor', 1)).toBe('Bbmajor');
    expect(transposeMode('Eminor', 2)).toBe('F#minor');
    expect(transposeMode('Dmajor', -1)).toBe('Dbmajor');
    expect(transposeMode('Gmixolydian', 1)).toBe('Abmixolydian');
    expect(transposeMode('Bminor', -1)).toBe('Bbminor');
    expect(transposeMode('Adorian', -2)).toBe('Gdorian');
  });

  it('returns what it cannot read untouched', () => {
    expect(transposeMode('', 3)).toBe('');
    expect(transposeMode('Hmajor', 3)).toBe('Hmajor');
    expect(transposeMode('Dweird', 3)).toBe('Dweird');
  });
});
